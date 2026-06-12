import React from 'react';
import { Navigate } from 'react-router-dom';

/**
 * Route protection wrapper component specifically for Admin role access.
 * Checks for token existence, checks the role from local storage, and redirects
 * non-Admin users to the dashboard. Redirects unauthenticated users to the login screen.
 */
const AdminRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  const userString = localStorage.getItem('user');

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  try {
    const user = userString ? JSON.parse(userString) : null;
    
    // Redirect if user object is missing or role is not Admin
    if (!user || user.role !== 'Admin') {
      return <Navigate to="/dashboard" replace />;
    }
  } catch (error) {
    console.error('Error checking admin role status:', error);
    return <Navigate to="/login" replace />;
  }

  return children;
};

export default AdminRoute;
