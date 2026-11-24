"use strict";

(() => {
  const $ = (selector) => document.querySelector(selector);
  const api = window.studio;
  let state = {
    available: false,
    guests: [],
    catalog: [],
    history: [],
    totalGifts: 0,
  };
  let selectedGuest = null,
    selectedGift = null,
    creator = "Creator",
    busy = false,
    pending = null;
  const effects = [];
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const count = () => Number($("#gift-quantity").value);
  const recipient = () =>
    state.guests.find((guest) => guest.id === selectedGuest);
  const choice = () => state.catalog.find((gift) => gift.id === selectedGift);
  const status = (message, error = false) => {
    $("#gift-status").textContent = message;
    $("#gift-status").classList.toggle("is-error", error);
  };
  function controls() {
    const guest = recipient(),
      gift = choice(),
      validCount = Number.isInteger(count()) && count() >= 1 && count() <= 99;
    $("#gift-send").disabled =
      busy || !state.available || !guest || !gift || !validCount;
    $("#gift-send").textContent = busy
      ? "Saving…"
      : guest && gift
        ? `Send ${gift.name} ×${validCount ? count() : "?"}`
        : "Choose a guest";
    $("#gift-recipient").textContent = guest
      ? `To ${guest.name} · Box ${guest.seat}`
      : "Select a guest box to get started.";
    $("#gift-sender").textContent = "Sending as " + creator;
    $("#gift-remove-guest").disabled = busy || !state.available || !guest;
    $("#gift-add-guest").disabled =
      busy || !state.available || state.guests.length >= 9;
    $("#gift-add-board").disabled = !state.available;
    for (const field of [
      "#gift-guest-name",
      "#gift-guest-seat",
      "#gift-quantity",
    ])
      $(field).disabled = busy || !state.available;
    document.querySelectorAll("[data-gift-quantity]").forEach((button) => {
      button.disabled = busy || !state.available;
    });
  }
  function render() {
    $("#gift-guest-count").textContent = state.guests.length + " / 9";
    $("#gift-total").textContent =
      state.totalGifts.toLocaleString() + " studio gifts";
    const grid = $("#gift-guest-grid");
    grid.replaceChildren();
    const seats = $("#gift-guest-seat"),
      oldSeat = Number(seats.value);
    seats.replaceChildren();
    for (let seat = 1; seat <= 9; seat++) {
      const guest = state.guests.find((guest) => guest.seat === seat);
      const tile = make(
        "button",
        "gift-guest-tile" + (guest?.id === selectedGuest ? " is-selected" : ""),
      );
      tile.type = "button";
      tile.disabled = busy || !state.available;
      tile.setAttribute(
        "aria-label",
        guest
          ? `Select ${guest.name} in box ${seat}`
          : `Add guest to box ${seat}`,
      );
      tile.setAttribute(
        "aria-pressed",
        String(Boolean(guest && guest.id === selectedGuest)),
      );
      tile.append(
        make("span", "gift-box-number", "BOX " + seat),
        make(
          "span",
          "gift-guest-avatar",
          guest ? guest.name.slice(0, 1).toUpperCase() : "+",
        ),
        make("strong", "", guest?.name || "Empty box"),
      );
      tile.addEventListener("click", () => {
        if (guest) {
          selectedGuest = guest.id;
          pending = null;
          render();
        } else {
          seats.value = String(seat);
          $("#gift-guest-name").focus();
        }
      });
      grid.append(tile);
      if (!guest) {
        const option = make("option", "", "Box " + seat);
        option.value = String(seat);
        seats.append(option);
      }
    }
    if ([...seats.options].some((option) => Number(option.value) === oldSeat))
      seats.value = String(oldSeat);
    const catalog = $("#gift-catalog");
    catalog.replaceChildren();
    for (const gift of state.catalog) {
      const button = make(
        "button",
        "gift-item" + (gift.id === selectedGift ? " is-selected" : ""),
      );
      button.type = "button";
      button.disabled = busy || !state.available;
      button.setAttribute("aria-label", "Choose " + gift.name);
      button.setAttribute("aria-pressed", String(gift.id === selectedGift));
      button.append(
        make("span", "gift-icon", gift.icon),
        make("strong", "", gift.name),
      );
      button.addEventListener("click", () => {
        selectedGift = gift.id;
        pending = null;
        render();
      });
      catalog.append(button);
    }
    const history = $("#gift-history");
    history.replaceChildren();
    if (!state.history.length)
      history.append(
        make(
          "p",
          "gift-empty-history",
          "Your studio gift history will appear here.",
        ),
      );
    for (const event of state.history.slice(0, 10)) {
      const gift = state.catalog.find((item) => item.id === event.giftId);
      const row = make("div", "gift-history-row");
      row.append(make("span", "gift-history-icon", gift?.icon || "🎁"));
      const detail = make("div");
      detail.append(
        make("strong", "", `${event.sender} → ${event.recipientName}`),
        make(
          "small",
          "",
          `${gift?.name || "Gift"} ×${event.quantity} · Box ${event.seat} · ${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        ),
      );
      row.append(detail);
      history.append(row);
    }
    controls();
  }
  function apply(next) {
    state = next;
    if (!state.guests.some((guest) => guest.id === selectedGuest))
      selectedGuest = state.guests[0]?.id || null;
    if (!state.catalog.some((gift) => gift.id === selectedGift))
      selectedGift = state.catalog[0]?.id || null;
    render();
    if (!state.available)
      status(state.message || "Studio gifts are unavailable.", true);
  }
  async function operation(action) {
    if (busy || !state.available) return;
    busy = true;
    controls();
    try {
      await action();
    } catch (error) {
      status(error.message || "The gift could not be saved. Try again.", true);
    } finally {
      busy = false;
      render();
    }
  }
  $("#gifts-button").addEventListener("click", () => {
    render();
    $("#gifting-dialog").showModal();
  });
  $("#gift-guest-form").addEventListener("submit", (event) => {
    event.preventDefault();
    return operation(async () => {
      const result = await api.addGiftGuest({
        name: $("#gift-guest-name").value,
        seat: Number($("#gift-guest-seat").value),
      });
      selectedGuest = result.guest.id;
      pending = null;
      apply(result.state);
      $("#gift-guest-name").value = "";
      status(`${result.guest.name} added to local box ${result.guest.seat}.`);
    });
  });
  $("#gift-remove-guest").addEventListener("click", () =>
    operation(async () => {
      const guest = recipient();
      if (!guest) return;
      apply(await api.removeGiftGuest(guest.id));
      pending = null;
      status(
        `${guest.name} removed from the box. Previous gift history is retained.`,
      );
    }),
  );
  $("#gift-quantity").addEventListener("input", () => {
    pending = null;
    controls();
  });
  document.querySelectorAll("[data-gift-quantity]").forEach((button) =>
    button.addEventListener("click", () => {
      $("#gift-quantity").value = button.dataset.giftQuantity;
      pending = null;
      controls();
    }),
  );
  $("#gift-send").addEventListener("click", () =>
    operation(async () => {
      const guest = recipient(),
        gift = choice();
      if (!guest || !gift)
        throw new Error("Select a guest box and a gift first.");
      if (!Number.isInteger(count()) || count() < 1 || count() > 99)
        throw new Error("Choose a quantity from 1 to 99.");
      pending ||= {
        recipientId: guest.id,
        giftId: gift.id,
        quantity: count(),
        requestId: crypto.randomUUID(),
      };
      const result = await api.sendGift(pending);
      apply(result.state);
      if (!result.duplicate) {
        effects.push({ ...result.receipt, started: performance.now() });
        if (effects.length > 12) effects.shift();
        const card = [...$("#gift-guest-grid").children].find(
          (card) => card.getAttribute("aria-pressed") === "true",
        );
        card?.animate?.(
          [
            { transform: "scale(1)" },
            { transform: "scale(1.07)", borderColor: gift.color },
            { transform: "scale(1)" },
          ],
          { duration: 650 },
        );
      }
      pending = null;
      status(
        `${gift.icon} ${gift.name} ×${result.receipt.quantity} recorded for ${result.receipt.recipientName}. Local studio only.`,
      );
    }),
  );
  $("#gift-add-board").addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("studio:add-guest-board"));
    $("#gifting-dialog").close();
  });
  function setCreator(name) {
    if (creator !== name) pending = null;
    creator = name;
    controls();
  }
  function draw(ctx, source) {
    const { x, y, width, height } = source,
      columns = width >= height ? 3 : 2,
      rows = Math.ceil(9 / columns);
    const scale = Math.min(width / 1000, height / 700),
      pad = 22 * scale,
      top = 82 * scale,
      bottom = 38 * scale;
    const w = (width - pad * (columns + 1)) / columns,
      h = (height - top - bottom - pad * (rows - 1)) / rows;
    const now = performance.now();
    while (effects.length && now - effects[0].started > 5000) effects.shift();
    ctx.fillStyle = "#101b27";
    ctx.fillRect(x, y, width, height);
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.font = `600 ${26 * scale}px 'Segoe UI',sans-serif`;
    ctx.fillStyle = "#edf7ff";
    ctx.fillText("GUEST BOXES", x + pad, y + 20 * scale);
    ctx.font = `${13 * scale}px 'Segoe UI',sans-serif`;
    ctx.fillStyle = "#93afc5";
    ctx.fillText(
      "Local studio cards · no remote guest connection",
      x + pad,
      y + 55 * scale,
      width - 2 * pad,
    );
    for (let seat = 1; seat <= 9; seat++) {
      const guest = state.guests.find((guest) => guest.seat === seat),
        gx = x + pad + ((seat - 1) % columns) * (w + pad),
        gy = y + top + Math.floor((seat - 1) / columns) * (h + pad);
      const effect =
          guest &&
          effects.filter((effect) => effect.recipientId === guest.id).at(-1),
        gift =
          effect && state.catalog.find((gift) => gift.id === effect.giftId);
      ctx.fillStyle = guest ? "#203449" : "#152331";
      ctx.beginPath();
      ctx.roundRect(gx, gy, w, h, 14 * scale);
      ctx.fill();
      ctx.strokeStyle = effect ? gift.color : guest ? "#3d657d" : "#294052";
      ctx.lineWidth = effect ? 4 * scale : scale;
      ctx.stroke();
      ctx.font = `${12 * scale}px 'Segoe UI',sans-serif`;
      ctx.fillStyle = "#9cb7cb";
      ctx.fillText("BOX " + seat, gx + 14 * scale, gy + 12 * scale);
      ctx.textAlign = "center";
      ctx.font = `600 ${Math.min(42 * scale, h * 0.25)}px 'Segoe UI Emoji','Segoe UI',sans-serif`;
      ctx.fillStyle = guest ? "#9ee7e2" : "#557084";
      ctx.fillText(
        effect ? gift.icon : guest ? guest.name.slice(0, 1).toUpperCase() : "+",
        gx + w / 2,
        gy + h * 0.26,
      );
      ctx.font = `600 ${19 * scale}px 'Segoe UI',sans-serif`;
      ctx.fillStyle = guest ? "#e9f6ff" : "#7391a7";
      ctx.fillText(
        guest?.name || "Empty guest box",
        gx + w / 2,
        gy + h * 0.64,
        w - 24 * scale,
      );
      if (effect) {
        ctx.font = `600 ${14 * scale}px 'Segoe UI',sans-serif`;
        ctx.fillStyle = gift.color;
        ctx.fillText(
          `${effect.sender} · ${gift.name} ×${effect.quantity}`,
          gx + w / 2,
          gy + h * 0.83,
          w - 20 * scale,
        );
        ctx.save();
        ctx.globalAlpha *= 1 - (now - effect.started) / 5000;
        for (let index = 0; index < 5; index++) {
          const travel = ((now - effect.started) / 1600 + index / 5) % 1;
          ctx.font = `${(18 + (index % 2) * 7) * scale}px 'Segoe UI Emoji',sans-serif`;
          ctx.fillText(
            gift.icon,
            gx + w * (0.15 + index * 0.17),
            gy + h * (0.8 - travel * 0.65),
          );
        }
        ctx.restore();
      }
      ctx.textAlign = "left";
    }
    ctx.font = `${12 * scale}px 'Segoe UI',sans-serif`;
    ctx.fillStyle = "#8eabbf";
    ctx.fillText(
      "STUDIO GIFTS · NO CASH VALUE",
      x + pad,
      y + height - 22 * scale,
    );
  }
  window.giftBoard = Object.freeze({
    initialize(next, name = "Creator") {
      creator = name;
      apply(next || state);
    },
    setCreator,
    draw,
  });
})();
