import React from 'react';
import { Navigate } from 'react-router-dom';

/**
 * Route protection wrapper component
 * If token doesn't exist, redirects user to /login
 */
const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('token');

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

export default ProtectedRoute;
