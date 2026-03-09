import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

interface Notification {
  id: string;
  type: string;
  title: string;
  content: string | null;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  created_at: string;
}

export default function NotificationBell() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);

  // Load notifications on mount
  useEffect(() => {
    loadNotifications();
  }, []);

  // Socket.io connection for real-time notifications
  useEffect(() => {
    if (!user) return;

    const socket = io(window.location.origin, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      socket.emit('auth', user.id);
    });

    socket.on('notification', (notif: Notification) => {
      setNotifications((prev) => [notif, ...prev]);
      setUnreadCount((prev) => prev + 1);
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
    };
  }, [user]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function loadNotifications() {
    try {
      const data = await api.get<{ data: Notification[]; unread_count: number }>('/notifications?limit=20');
      setNotifications(data.data);
      setUnreadCount(data.unread_count);
    } catch (err) {
      console.error('Failed to load notifications:', err);
    }
  }

  async function markAllRead() {
    try {
      await api.post('/notifications/read', {});
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark read:', err);
    }
  }

  function handleNotificationClick(notif: Notification) {
    // Navigate to the entity if available
    if (notif.entity_type && notif.entity_id) {
      navigate(`/${notif.entity_type}/${notif.entity_id}`);
    }
    setOpen(false);

    // Mark as read
    if (!notif.is_read) {
      api.post('/notifications/read', { notification_ids: [notif.id] }).catch(() => {});
      setNotifications((prev) =>
        prev.map((n) => (n.id === notif.id ? { ...n, is_read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    }
  }

  function formatTimeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative p-1 text-ooosh-200 hover:text-white transition-colors"
        title="Notifications"
      >
        {/* Bell icon */}
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-lg shadow-xl border border-gray-200 z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">No notifications yet.</p>
            ) : (
              notifications.map((notif) => (
                <button
                  key={notif.id}
                  onClick={() => handleNotificationClick(notif)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                    !notif.is_read ? 'bg-ooosh-50/50' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!notif.is_read && (
                      <span className="w-2 h-2 rounded-full bg-ooosh-500 mt-1.5 flex-shrink-0" />
                    )}
                    <div className={`flex-1 min-w-0 ${notif.is_read ? 'ml-4' : ''}`}>
                      <p className="text-sm font-medium text-gray-900">{notif.title}</p>
                      {notif.content && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{notif.content}</p>
                      )}
                      <p className="text-xs text-gray-400 mt-1">{formatTimeAgo(notif.created_at)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
