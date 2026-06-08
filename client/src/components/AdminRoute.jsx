import React from 'react';
import { Navigate } from 'react-router-dom';
import { jwtDecode } from 'jwt-decode';

/**
 * Route protection wrapper component specifically for Admin role access.
 * Checks for token existence, decodes the role, and redirects non-Admin
 * users to the dashboard. Redirects unauthenticated users to the login screen.
 */
const AdminRoute = ({ children }) => {
  const token = localStorage.getItem('token');

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  try {
    const decoded = jwtDecode(token);
    
    // Redirect if role is not Admin
    if (decoded.role !== 'Admin') {
      return <Navigate to="/dashboard" replace />;
    }
  } catch (error) {
    console.error('Error decoding admin token:', error);
    return <Navigate to="/login" replace />;
  }

  return children;
};

export default AdminRoute;
