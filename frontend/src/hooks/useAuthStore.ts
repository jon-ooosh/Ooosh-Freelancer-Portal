import { create } from 'zustand';

interface User {
  id: string;
  email: string;
  role: string;
  first_name: string;
  last_name: string;
  avatar_url?: string | null;
  force_password_change?: boolean;
  cot_card_last4?: string | null;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  login: (user: User, accessToken: string, refreshToken: string) => void;
  logout: () => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  updateUser: (updates: Partial<User>) => void;
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

  updateUser: (updates) => {
    set((state) => {
      if (!state.user) return state;
      const updated = { ...state.user, ...updates };
      localStorage.setItem('ooosh_user', JSON.stringify(updated));
      return { user: updated };
    });
  },
}));

// Cross-tab sync: `storage` fires in OTHER tabs when a key is written here.
// Keeps every tab on the same token pair so one tab's refresh doesn't
// invalidate another tab's session via the server's refresh-token rotation.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.storageArea !== localStorage) return;
    if (e.key === 'ooosh_access_token' || e.key === 'ooosh_refresh_token' || e.key === 'ooosh_user') {
      const accessToken = localStorage.getItem('ooosh_access_token');
      const refreshToken = localStorage.getItem('ooosh_refresh_token');
      const userRaw = localStorage.getItem('ooosh_user');
      const user = userRaw ? JSON.parse(userRaw) : null;
      useAuthStore.setState({
        user,
        accessToken,
        refreshToken,
        isAuthenticated: !!accessToken,
      });
    }
  });
}
