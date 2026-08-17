export function medicationResourceClient(api) {
  const request = (path, options) => api(`/api/medications${path}`, options)

  return {
    async list() {
      const data = await request('/resources')
      return Array.isArray(data?.medications) ? data.medications : []
    },
    async get(id) {
      return (await request(`/resources/${id}`)).medication
    },
    async create(medication) {
      return (await request('/resources', {
        method: 'POST',
        body: JSON.stringify({ medication }),
      })).medication
    },
    async update(id, version, medication) {
      return (await request(`/resources/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ version, medication }),
      })).medication
    },
    async remove(id, version) {
      return request(`/resources/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({ version }),
      })
    },
    async listMedicationLists() {
      return request('/lists')
    },
    async listShares() {
      return request('/list/shares')
    },
    async revokeShare(userId, version) {
      return request(`/list/shares/${userId}`, {
        method: 'DELETE',
        body: JSON.stringify({ version }),
      })
    },
  }
}

export function medicationData(medication) {
  const {
    resourceId: _resourceId,
    resourceVersion: _resourceVersion,
    resourceAccess: _resourceAccess,
    ...data
  } = medication
  return {
    ...data,
    history: (medication.history || []).map((event) => {
      const { resourceEventId: _resourceEventId, ...record } = event
      return record
    }),
  }
}

export function privateMedicationSnapshot(medications) {
  return medications
    .filter((medication) =>
      !medication.resourceId || medication.resourceAccess?.role === 'owner')
    .map(medicationData)
}

export function medicationPermissions(medication) {
  const access = medication.resourceAccess
  const role = access?.role || 'owner'
  const canViewHistory = access?.canViewHistory ?? role === 'owner'
  const canViewSchedule = access?.canViewSchedule ?? canViewHistory
  return {
    role,
    canEdit: role === 'owner' || role === 'editor',
    canDelete: role === 'owner',
    canShare: access?.canShare ?? role === 'owner',
    canViewHistory,
    canViewSchedule,
    ownerUserId: access?.ownerUserId || null,
    ownerUsername: access?.ownerUsername || null,
    ownerTimezone: access?.ownerTimezone || null,
  }
}
