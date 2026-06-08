import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Navbar from './Navbar';
import Sidebar from './Sidebar';

const ProtectedLayout = () => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

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
