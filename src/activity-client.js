export function activityClient(request) {
  const call = (path, options) => request(`/api/activity${path}`, options)
  return {
    async list() {
      const data = await call('/')
      return Array.isArray(data?.activities) ? data.activities : []
    },
    read: (id) => call(`/${id}/read`, { method: 'POST' }),
    readAll: () => call('/read-all', { method: 'POST' }),
  }
}
