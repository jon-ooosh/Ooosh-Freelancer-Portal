import { create } from 'zustand';

interface User {
  id: string;
  email: string;
  role: string;
  first_name: string;
  last_name: string;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  login: (user: User, accessToken: string, refreshToken: string) => void;
  logout: () => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: JSON.parse(localStorage.getItem('ooosh_user') || 'null'),
  accessToken: localStorage.getItem('ooosh_access_token'),
  refreshToken: localStorage.getItem('ooosh_refresh_token'),
  isAuthenticated: !!localStorage.getItem('ooosh_access_token'),

  login: (user, accessToken, refreshToken) => {
    localStorage.setItem('ooosh_user', JSON.stringify(user));
    localStorage.setItem('ooosh_access_token', accessToken);
    localStorage.setItem('ooosh_refresh_token', refreshToken);
    set({ user, accessToken, refreshToken, isAuthenticated: true });
  },

  logout: () => {
    localStorage.removeItem('ooosh_user');
    localStorage.removeItem('ooosh_access_token');
    localStorage.removeItem('ooosh_refresh_token');
    set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false });
  },

  setTokens: (accessToken, refreshToken) => {
    localStorage.setItem('ooosh_access_token', accessToken);
    localStorage.setItem('ooosh_refresh_token', refreshToken);
    set({ accessToken, refreshToken });
  },
}));
