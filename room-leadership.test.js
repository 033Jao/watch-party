'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { electLeader, canJoinRoom, roleFor } = require('../room-leadership');

const guest = userId => ({ userId: String(userId), isOwner: false });
const owner = userId => ({ userId: String(userId), isOwner: true });

test('primeiro convidado assume quando o dono está ausente', () => {
  const members = new Map([['guest-a', guest(20)]]);
  assert.equal(electLeader(members, 10), 'guest-a');
});

test('novo convidado não rouba liderança temporária', () => {
  const members = new Map([['guest-a', guest(20)], ['guest-b', guest(30)]]);
  assert.equal(electLeader(members, 10, 'guest-a'), 'guest-a');
});

test('dono que retorna recupera a liderança automaticamente', () => {
  const members = new Map([['guest-a', guest(20)], ['owner-new-session', owner(10)]]);
  assert.equal(electLeader(members, 10, 'guest-a'), 'owner-new-session');
});

test('se o líder temporário sair, outro convidado assume', () => {
  const members = new Map([['guest-b', guest(30)], ['guest-c', guest(40)]]);
  assert.equal(electLeader(members, 10, 'guest-a'), 'guest-b');
});

test('se uma sessão do dono sair, outra sessão do dono mantém a liderança', () => {
  const members = new Map([['guest-a', guest(20)], ['owner-tab-2', owner(10)]]);
  assert.equal(electLeader(members, 10, 'owner-tab-1'), 'owner-tab-2');
});

test('papel distingue dono e líder temporário', () => {
  assert.deepEqual(roleFor('guest-a', guest(20), 'guest-a'), {
    isCreator: true, isLeader: true, isOwner: false
  });
  assert.deepEqual(roleFor('owner-a', owner(10), 'owner-a'), {
    isCreator: true, isLeader: true, isOwner: true
  });
});

test('sem membros, não existe líder', () => {
  assert.equal(electLeader(new Map(), 10), null);
});

test('reserva uma vaga para o dono enquanto ele está ausente', () => {
  const members = new Map([['guest-a', guest(20)], ['guest-b', guest(30)]]);
  assert.equal(canJoinRoom(members, 10, 40, 3), false);
  assert.equal(canJoinRoom(members, 10, 10, 3), true);
});

test('com o dono conectado, convidados podem preencher as vagas restantes', () => {
  const members = new Map([['owner', owner(10)], ['guest-a', guest(20)]]);
  assert.equal(canJoinRoom(members, 10, 30, 3), true);
  members.set('guest-b', guest(30));
  assert.equal(canJoinRoom(members, 10, 40, 3), false);
});
