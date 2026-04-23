const USER_ROLES = {
  SUPER_ADMIN: "super-admin",
  ADMIN: "admin",
  USER: "user"
};

function canManageUsers(currentRole) {
  return currentRole === USER_ROLES.ADMIN || currentRole === USER_ROLES.SUPER_ADMIN;
}

function canCreateRole(currentRole, newRole) {
  if (currentRole === USER_ROLES.SUPER_ADMIN) {
    return [USER_ROLES.ADMIN, USER_ROLES.USER].includes(newRole);
  }

  if (currentRole === USER_ROLES.ADMIN) {
    return newRole === USER_ROLES.USER;
  }

  return false;
}

function canEditTargetUser(currentRole, targetRole) {
  if (targetRole === USER_ROLES.SUPER_ADMIN) return false;

  if (currentRole === USER_ROLES.SUPER_ADMIN) {
    return [USER_ROLES.ADMIN, USER_ROLES.USER].includes(targetRole);
  }

  if (currentRole === USER_ROLES.ADMIN) {
    return targetRole === USER_ROLES.USER;
  }

  return false;
}

function canDeleteTargetUser(currentRole, targetRole) {
  return canEditTargetUser(currentRole, targetRole);
}

function normalizeUserRow(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  USER_ROLES,
  canManageUsers,
  canCreateRole,
  canEditTargetUser,
  canDeleteTargetUser,
  normalizeUserRow
};