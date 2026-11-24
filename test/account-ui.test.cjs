'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function ui(bridge) {
  const elements = new Map();
  function get(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: false, disabled: false, listeners: {}, attributes: {},
      addEventListener(event, callback) { this.listeners[event] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      setCustomValidity(message) { this.validityMessage = message; },
      reportValidity() { this.reported = true; }, showModal() { this.open = true; }
    });
    return elements.get(id);
  }
  const fields = ['name', 'email', 'password', 'confirm-password', 'submit'].map(name => get('#account-' + name));
  get('#account-form').elements = fields;
  get('#account-form').reset = () => fields.forEach(field => { field.value = ''; });
  const source = await fs.readFile(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const subject = source.slice(source.indexOf('function renderAccount()'), source.indexOf('function syncWebSources()'));
  const context = vm.createContext({ $, bridge, window: {} });
  function $(key) { return get(key); }
  vm.runInContext('let accountState={user:null,available:true}; let accountMode="login"; let accountBusy=false; function notify(){}; ' + subject + '; globalThis.state=()=>accountState;', context);
  return { get, state: context.state, event: (id, event) => get(id).listeners[event]({ preventDefault() {} }) };
}

test('account form switches modes, validates confirmation, and clears passwords after account creation', async () => {
  const calls = [], user = { id: 'fixture', name: 'QA Studio', email: 'qa@example.invalid' };
  const subject = await ui({ createAccount: async input => { calls.push(input); return user; } });
  await subject.event('#account-create-mode', 'click');
  assert.equal(subject.get('#account-name').required, true);
  assert.equal(subject.get('#account-password').autocomplete, 'new-password');
  subject.get('#account-name').value = user.name;
  subject.get('#account-email').value = user.email;
  subject.get('#account-password').value = 'Synthetic-password-123';
  subject.get('#account-confirm-password').value = 'wrong';
  await subject.event('#account-form', 'submit');
  assert.equal(calls.length, 0);
  assert.equal(subject.get('#account-confirm-password').validityMessage, 'Passwords do not match.');
  subject.get('#account-confirm-password').value = 'Synthetic-password-123';
  await subject.event('#account-confirm-password', 'input');
  await subject.event('#account-form', 'submit');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].email, user.email);
  assert.equal(subject.state().user, user);
  assert.equal(subject.get('#account-display-name').textContent, user.name);
  assert.equal(subject.get('#account-signed-out').hidden, true);
  assert.equal(subject.get('#account-password').value, '');
  assert.equal(subject.get('#account-confirm-password').value, '');
});

test('failed sign-in displays the error, clears secrets and permits a retry', async () => {
  let reject;
  const subject = await ui({ signIn: () => new Promise((_, no) => { reject = no; }) });
  await subject.event('#account-login-mode', 'click');
  subject.get('#account-email').value = 'qa@example.invalid';
  subject.get('#account-password').value = 'Synthetic-password-123';
  const pending = subject.event('#account-form', 'submit');
  assert.equal(subject.get('#account-submit').disabled, true);
  reject(new Error('Email or password is incorrect.'));
  await pending;
  assert.equal(subject.get('#account-submit').disabled, false);
  assert.equal(subject.get('#account-password').value, '');
  assert.equal(subject.get('#account-email').value, 'qa@example.invalid');
  assert.equal(subject.get('#account-status').textContent, 'Email or password is incorrect.');
  assert.equal(subject.state().user, null);
});

test('successful sign-in updates account identity and sign-out restores the sign-in controls', async () => {
  const user = { id: 'fixture', name: '<synthetic-name>', email: 'qa@example.invalid' };
  const subject = await ui({ signIn: async () => user, signOut: async () => true });
  await subject.event('#account-login-mode', 'click');
  await subject.event('#account-form', 'submit');
  assert.equal(subject.get('#account-button-label').textContent, user.name);
  assert.equal(subject.get('#account-display-name').textContent, user.name);
  assert.equal(subject.get('#account-signed-in').hidden, false);
  await subject.event('#account-sign-out', 'click');
  assert.equal(subject.get('#account-button-label').textContent, 'Sign in / Account');
  assert.equal(subject.state().user, null);
  assert.equal(subject.get('#account-name').required, false);
});
