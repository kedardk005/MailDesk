import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

const Sidebar = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const userString = localStorage.getItem('user');
  let user = { name: 'Guest', role: 'Employee' };
  try {
    if (userString) {
      user = JSON.parse(userString);
    }
  } catch (err) {
    console.error('Error parsing user details for Sidebar:', err);
  }

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
    if (onClose) onClose();
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

  const navItems = [
    {
      path: '/dashboard',
      label: 'Dashboard',
      roles: ['Admin', 'Head', 'Employee'],
      icon: (
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
      )
    },
    {
      path: '/inbox',
      label: 'Inbox',
      roles: ['Admin', 'Head'],
      icon: (
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      )
    },
    {
      path: '/tasks',
      label: 'Tasks',
      roles: ['Admin', 'Head', 'Employee'],
      icon: (
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2" />
        </svg>
      )
    },
    {
      path: '/reports',
      label: 'Reports',
      roles: ['Admin'],
      icon: (
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2z" />
        </svg>
      )
    }
  ];

  const filteredItems = navItems.filter((item) => item.roles.includes(user.role));

  return (
    <>
      {/* Mobile Drawer Overlay Backdrop */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40 lg:hidden transition-all duration-300"
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed top-16 left-0 bottom-0 w-60 h-[calc(100vh-4rem)] bg-white border-r border-slate-200 z-40 flex flex-col justify-between overflow-y-auto transition-transform duration-300 lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col">
          {/* Header area for logo on mobile */}
          <div className="h-16 flex items-center px-6 border-b border-slate-100 lg:hidden justify-between">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-extrabold text-xs shrink-0">
                CE
              </div>
              <span className="font-bold text-slate-800 text-sm leading-none">TaskMail Central</span>
            </div>
            <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-650 rounded-lg">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* User Profile Block */}
          <div className="p-6 border-b border-slate-100 flex items-center space-x-3.5">
            <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-indigo-500 to-violet-500 flex items-center justify-center text-white font-bold text-sm shrink-0 shadow-md shadow-indigo-500/10">
              {getInitials(user.name)}
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-xs font-bold text-slate-800 truncate leading-snug">{user.name}</span>
              <span className="text-[9px] font-extrabold tracking-wider bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full w-max mt-1 uppercase font-mono">
                {user.role}
              </span>
            </div>
          </div>

          {/* Navigation vertical items list */}
          <nav className="p-4 space-y-1.5">
            {filteredItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={onClose}
                className={({ isActive }) =>
                  `flex items-center space-x-3 px-4 py-3 rounded-xl text-xs font-medium transition-all duration-150 border-l-4 ${
                    isActive
                      ? 'bg-indigo-50/60 border-indigo-600 text-indigo-600 font-semibold shadow-sm'
                      : 'border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-850'
                  }`
                }
              >
                <div className="shrink-0">{item.icon}</div>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>
        </div>

        {/* Footer Logout area */}
        <div className="p-4 border-t border-slate-100">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-semibold text-slate-500 hover:bg-red-50 hover:text-red-600 border border-transparent hover:border-red-100 transition-all duration-150"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span>Log Out</span>
          </button>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
