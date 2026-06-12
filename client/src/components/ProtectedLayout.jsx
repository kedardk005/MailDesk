import React, { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Navbar from './Navbar';
import Sidebar from './Sidebar';
import api from '../api/axios';

const ProtectedLayout = () => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Poll user profile to detect administrative updates (e.g. role changes, status suspension)
  useEffect(() => {
    const checkUserRoleAndStatus = async () => {
      try {
        const res = await api.get('/auth/me');
        const latestUser = res.data;
        const localUserString = localStorage.getItem('user');
        
        if (localUserString) {
          const localUser = JSON.parse(localUserString);
          
          // 1. Check if account is still Approved
          if (latestUser.status !== 'Approved') {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = '/login';
            return;
          }

          // 2. Check if role has changed
          if (localUser.role !== latestUser.role) {
            localStorage.setItem('user', JSON.stringify(latestUser));
            // Force reload to rebuild routes and reset application state
            window.location.reload();
            return;
          }

          // 3. Update other details if changed
          if (localUser.name !== latestUser.name || localUser.email !== latestUser.email) {
            localStorage.setItem('user', JSON.stringify(latestUser));
            window.dispatchEvent(new Event('storage'));
          }
        }
      } catch (err) {
        console.error('Failed to sync profile status:', err);
        // If unauthorized or forbidden, clear credentials and redirect to login
        if (err.response && (err.response.status === 401 || err.response.status === 403)) {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          window.location.href = '/login';
        }
      }
    };

    // Run immediately on layout load
    checkUserRoleAndStatus();

    // Check every 8 seconds for responsiveness with minimal server load
    const interval = setInterval(checkUserRoleAndStatus, 8000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans">
      {/* Global Navbar at the top */}
      <Navbar onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} />

      {/* Split Navigation layout */}
      <div className="relative pt-16 lg:pl-60">
        {/* Responsive Sidebar on the left */}
        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

        {/* Main Page scroll context on the right */}
        <div className="min-w-0">
          <div className="min-h-[calc(100vh-4rem)]">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProtectedLayout;
