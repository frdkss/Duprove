export const repository = import.meta.env.VITE_GITHUB_REPOSITORY || 'frdkss/Duprove'
export const repositoryUrl = `https://github.com/${repository}`
export const githubUsername = repository.split('/')[0]
export const githubProfileUrl = `https://github.com/${githubUsername}`
export const releasesUrl = `${repositoryUrl}/releases`
export const releasesApiUrl = `https://api.github.com/repos/${repository}/releases`
export const instructionsUrl = `${repositoryUrl}/blob/main/instruction.md`
export const instructionsRawUrl = `https://raw.githubusercontent.com/${repository}/main/instruction.md`
