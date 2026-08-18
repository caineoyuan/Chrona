export function buddyStreakClient(request) {
  const call = (path, options) => request(`/api/buddy-streaks${path}`, options)
  return {
    async list() {
      const data = await call('/')
      return Array.isArray(data?.buddyStreaks) ? data.buddyStreaks : []
    },
    get: (id) => call(`/${id}`),
    create: (definition) => call('/', {
      method: 'POST',
      body: JSON.stringify({ definition }),
    }),
    promote: (setId) => call('/promote', {
      method: 'POST',
      body: JSON.stringify({ setId }),
    }),
    update: (id, version, definition) => call(`/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ version, definition }),
    }),
    remove: (id, version) => call(`/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ version }),
    }),
    removeMember: (id, userId, version) => call(`/${id}/members/${userId}`, {
      method: 'DELETE',
      body: JSON.stringify({ version }),
    }),
    leave: (id, userId, version) => call(`/${id}/members/${userId}`, {
      method: 'DELETE',
      body: JSON.stringify({ version }),
    }),
    updateMember: (id, userId, version, role) => call(`/${id}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ version, role }),
    }),
    ping: (id, recipientUserId) => call(`/${id}/ping`, {
      method: 'POST',
      body: JSON.stringify({ recipientUserId }),
    }),
    complete: (id) => call(`/${id}/completion`, { method: 'PUT' }),
    undoCompletion: (id) => call(`/${id}/completion`, { method: 'DELETE' }),
    setCompletionDate: (id, dateKey, completed) => call(
      `/${id}/completions/${encodeURIComponent(dateKey)}`,
      { method: completed ? 'PUT' : 'DELETE' },
    ),
  }
}
