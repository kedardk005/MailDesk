import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
      className={`fixed top-0 left-0 right-0 h-16 bg-white border-b border-slate-200/80 z-50 flex items-center transition-all duration-200 ${
        isScrolled ? 'shadow-md shadow-slate-100' : ''
      }`}
    >
      <div className="w-full px-2 sm:px-3 lg:px-4 flex items-center justify-between">
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
            <div className="h-9 w-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-black text-xs shadow-md shadow-indigo-600/10 shrink-0">
              CE
            </div>
            <span className="font-extrabold text-sm text-slate-800 tracking-tight leading-none">
              TaskMail Central
            </span>
          </div>
        </div>

        {/* Right: Notifications, Avatar, Sign Out */}
        <div className="flex items-center gap-3">
          <NotificationBell />

          {/* User profile initials circle & details */}
          <div className="hidden sm:flex items-center space-x-2.5">
            <div className="h-8 w-8 rounded-full bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 font-extrabold text-xs">
              {getInitials(user.name)}
            </div>
            <div className="flex flex-col text-left">
              <span className="text-xs font-bold text-slate-800 leading-none">{user.name}</span>
              <span className="text-[9px] font-semibold text-slate-400 mt-0.5">{user.role}</span>
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="px-3 py-2 border border-slate-200 hover:border-slate-300 text-slate-550 rounded-xl text-xs font-bold hover:bg-slate-50 transition-all duration-150 flex items-center gap-1 bg-white"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span className="hidden sm:inline">Sign Out</span>
          </button>
        </div>
      </div>
    </header>
  );
};

export default Navbar;
