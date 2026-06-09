import React, { useState, useEffect } from 'react';
import { useNavigate, NavLink } from 'react-router-dom';
import NotificationBell from './NotificationBell';

const Navbar = ({ onToggleSidebar }) => {
  const navigate = useNavigate();
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Load user details
  const userString = localStorage.getItem('user');
  let user = { name: 'Guest', role: 'Employee' };
  try {
    if (userString) {
      user = JSON.parse(userString);
    }
  } catch (err) {
    console.error('Error parsing user details for Navbar rendering:', err);
  }

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  const getInitials = (name) => {
    if (!name) return 'U';
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <header
      className={`fixed top-0 left-0 right-0 h-16 bg-white/95 backdrop-blur-xl border-b border-slate-100 z-50 flex items-center transition-all duration-300 ${
        isScrolled ? 'shadow-[0_4px_20px_rgba(99,102,241,0.05)] border-slate-200/50' : 'border-slate-100'
      }`}
    >
      <div className="w-full px-4 sm:px-6 lg:px-8 flex items-center justify-between">
        
        {/* Left: Hamburger & Brand */}
        <div className="flex items-center gap-2">
          {/* Mobile hamburger menu */}
          <button
            onClick={onToggleSidebar}
            className="p-2 text-slate-500 hover:bg-slate-50 rounded-xl lg:hidden focus:outline-none transition-colors"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-md shadow-indigo-600/10 shrink-0">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
                <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
              </svg>
            </div>
            <span className="font-extrabold text-sm text-slate-900 tracking-tight leading-none">
              MailDesk
            </span>
          </div>
        </div>

        {/* Right: Notifications, Avatar */}
        <div className="flex items-center gap-4">
          <NotificationBell />

          {/* User profile initials circle & details */}
          <div className="hidden sm:flex items-center space-x-2.5">
            <div className="p-[2px] bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 rounded-full shadow-sm shrink-0">
              <div className="h-7 w-7 rounded-full bg-white flex items-center justify-center text-indigo-600 font-extrabold text-[10px]">
                {getInitials(user.name)}
              </div>
            </div>
            <div className="flex flex-col text-left">
              <span className="text-xs font-bold text-slate-800 leading-none">{user.name}</span>
              <span className="text-[9px] font-bold text-slate-400 mt-1.5 uppercase font-mono tracking-wider bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded">
                {user.role}
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Navbar;
