export const repository = import.meta.env.VITE_GITHUB_REPOSITORY || 'frdkss/Duprove'
export const repositoryUrl = `https://github.com/${repository}`
export const releasesUrl = `${repositoryUrl}/releases`
export const releasesApiUrl = `https://api.github.com/repos/${repository}/releases`
