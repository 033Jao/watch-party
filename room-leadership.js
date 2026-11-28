'use strict';

/**
 * Eleição determinística de líder por sala.
 * Prioridade: dono conectado > líder atual ainda conectado > primeiro membro.
 * `members` é um Map<socketId, { userId, isOwner }>.
 */
function electLeader(members, ownerUserId, currentLeaderId = null) {
  const ownerId = String(ownerUserId);
  for (const [socketId, member] of members) {
    if (String(member.userId) === ownerId || member.isOwner === true) return socketId;
  }
  if (currentLeaderId && members.has(currentLeaderId)) return currentLeaderId;
  return members.keys().next().value || null;
}

function canJoinRoom(members, ownerUserId, userId, maxMembers) {
  const ownerId = String(ownerUserId);
  const isOwner = String(userId) === ownerId;
  const ownerConnected = [...members.values()].some(member =>
    String(member.userId) === ownerId || member.isOwner === true
  );
  const memberLimit = ownerConnected ? maxMembers : Math.max(1, maxMembers - 1);
  if (!isOwner && members.size >= memberLimit) return false;
  if (isOwner && ownerConnected && members.size >= maxMembers) return false;
  return true;
}

function roleFor(socketId, member, leaderId) {
  const isLeader = socketId === leaderId;
  return {
    isCreator: isLeader, // Compatibilidade com clientes de versões anteriores.
    isLeader,
    isOwner: !!(member && member.isOwner)
  };
}

module.exports = { electLeader, canJoinRoom, roleFor };
