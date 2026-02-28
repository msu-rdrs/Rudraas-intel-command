export const BETA_MODE = typeof window !== 'undefined'
  && localStorage.getItem('rudraas-beta-mode') === 'true';
