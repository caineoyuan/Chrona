const sharingSetting = import.meta.env?.VITE_SHARING_ENABLED?.trim().toLowerCase()

export const sharingEnabled = sharingSetting !== 'false'
