import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import Dashboard from './pages/Dashboard';
import ManageUsers from './pages/admin/ManageUsers';
import ActivityLog from './pages/admin/ActivityLog';
import EmailInbox from './pages/EmailInbox';
import TaskList from './pages/TaskList';
import Profile from './pages/Profile';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import ProtectedLayout from './components/ProtectedLayout';
import Reports from './pages/admin/Reports';
import { initScrollAnimations } from './utils/scrollAnimations';

function App() {
  useEffect(() => {
    const cleanupScroll = initScrollAnimations();
    return () => {
      if (cleanupScroll) cleanupScroll();
    };
  }, []);

  return (
    <Router>
      <Routes>
        {/* Landing Page Route */}
        <Route path="/" element={<Landing />} />
        
        {/* Public Routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        
        {/* Protected Routes Wrapper */}
        <Route
          element={
            <ProtectedRoute>
              <ProtectedLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/inbox" element={<EmailInbox />} />
          <Route path="/tasks" element={<TaskList />} />
          <Route path="/profile" element={<Profile />} />
          
          {/* Admin Routes */}
          <Route
            path="/reports"
            element={
              <AdminRoute>
                <Reports />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/users"
            element={
              <AdminRoute>
                <ManageUsers />
              </AdminRoute>
            }
          />
          <Route
            path="/admin/activities"
            element={
              <AdminRoute>
                <ActivityLog />
              </AdminRoute>
            }
          />
        </Route>
        
        {/* Fallback redirect */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
