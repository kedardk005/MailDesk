import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../../api/axios';

const ManageUsers = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [alert, setAlert] = useState({ type: '', message: '' });
  const [currentUser, setCurrentUser] = useState(null);

  // Modal states
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  // Form states
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'Employee' });
  const [editUser, setEditUser] = useState({ id: '', name: '', email: '', role: 'Employee' });
  const [deleteUserId, setDeleteUserId] = useState('');

  const navigate = useNavigate();

  useEffect(() => {
    const userString = localStorage.getItem('user');
    if (userString) {
      try {
        setCurrentUser(JSON.parse(userString));
      } catch (err) {
        console.error('Error parsing current user:', err);
      }
    }
    fetchUsers();
  }, []);

  const triggerAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => {
      setAlert({ type: '', message: '' });
    }, 4000);
  };

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await api.get('/users');
      setUsers(response.data);
    } catch (err) {
      console.error('Failed to fetch users:', err);
      const message = err.response?.data?.message || 'Failed to load users. Please refresh the page.';
      triggerAlert('error', message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    if (!newUser.name || !newUser.email || !newUser.password || !newUser.role) {
      triggerAlert('error', 'All fields are required.');
      return;
    }

    setActionLoading(true);
    try {
      await api.post('/users', newUser);
      triggerAlert('success', `User '${newUser.name}' created successfully.`);
      setIsAddOpen(false);
      setNewUser({ name: '', email: '', password: '', role: 'Employee' });
      fetchUsers();
    } catch (err) {
      console.error('Error creating user:', err);
      const message = err.response?.data?.message || 'Failed to create user.';
      triggerAlert('error', message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditUser = async (e) => {
    e.preventDefault();
    if (!editUser.name || !editUser.email || !editUser.role) {
      triggerAlert('error', 'Name, email, and role are required.');
      return;
    }

    setActionLoading(true);
    try {
      await api.put(`/users/${editUser.id}`, {
        name: editUser.name,
        email: editUser.email,
        role: editUser.role
      });
      triggerAlert('success', `User '${editUser.name}' updated successfully.`);
      setIsEditOpen(false);
      fetchUsers();
    } catch (err) {
      console.error('Error updating user:', err);
      const message = err.response?.data?.message || 'Failed to update user.';
      triggerAlert('error', message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteUserId) return;
    
    if (currentUser && currentUser._id === deleteUserId) {
      triggerAlert('error', 'You cannot delete your own Administrator account.');
      setIsDeleteOpen(false);
      return;
    }

    setActionLoading(true);
    try {
      await api.delete(`/users/${deleteUserId}`);
      triggerAlert('success', 'User account deleted successfully.');
      setIsDeleteOpen(false);
      setDeleteUserId('');
      fetchUsers();
    } catch (err) {
      console.error('Error deleting user:', err);
      const message = err.response?.data?.message || 'Failed to delete user.';
      triggerAlert('error', message);
    } finally {
      setActionLoading(false);
    }
  };

  const openEditModal = (user) => {
    setEditUser({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role
    });
    setIsEditOpen(true);
  };

  const openDeleteModal = (id) => {
    setDeleteUserId(id);
    setIsDeleteOpen(true);
  };

  const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  return (
    <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 relative animate-fade-in select-none">
      {/* Admin Submenu Tabs */}
      <div className="flex justify-start items-center space-x-6 mb-8 border-b border-slate-200 pb-4">
        <Link to="/admin/users" className="text-sm font-bold text-indigo-600 border-b-2 border-indigo-600 pb-4 -mb-[17px] transition-all">
          Manage Users
        </Link>
        <Link to="/admin/activities" className="text-sm font-semibold text-slate-500 hover:text-slate-800 pb-4 -mb-[17px] transition-all">
          Activity Logs
        </Link>
      </div>

      {/* Alert */}
      {alert.message && (
        <div className={`fixed top-20 right-6 z-50 px-4 py-3 rounded-xl shadow-lg border flex items-start space-x-3 max-w-md animate-slide-in ${
          alert.type === 'success'
            ? 'bg-emerald-50 border-emerald-100 text-emerald-600'
            : 'bg-red-50 border-red-100 text-red-550'
        }`}>
          <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {alert.type === 'success' ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            )}
          </svg>
          <span className="text-xs font-semibold">{alert.message}</span>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-800 tracking-tight">User Management</h1>
          <p className="text-slate-500 text-sm mt-1">
            Manage workspace users, roles, and permissions
          </p>
        </div>
        <button
          onClick={() => setIsAddOpen(true)}
          className="px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white shadow-md active:scale-[0.98] transition-all flex items-center justify-center space-x-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          <span>Add User</span>
        </button>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden hover-glow-card transition-all duration-300">
        {loading ? (
          <div className="space-y-4 p-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-16 bg-white border border-slate-200/80 rounded-xl p-4 skeleton-shimmer" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-14 h-14 mx-auto bg-slate-50 rounded-2xl flex items-center justify-center mb-4 border border-slate-100">
              <svg className="w-6 h-6 text-slate-405" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h3 className="text-md font-bold text-slate-800 mb-1">No users found</h3>
            <p className="text-xs text-slate-500">Get started by creating a new user account.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50/50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <tr>
                  <th scope="col" className="px-6 py-4">User</th>
                  <th scope="col" className="px-6 py-4">Email</th>
                  <th scope="col" className="px-6 py-4">Role</th>
                  <th scope="col" className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-100 text-sm">
                {users.map((user) => {
                  const isSelf = currentUser && currentUser._id === user._id;
                  const initials = getInitials(user.name);
                  
                  // Role label color
                  let roleClass = 'bg-indigo-50 border-indigo-100 text-indigo-650';
                  if (user.role === 'Admin') {
                    roleClass = 'bg-red-50 border-red-100 text-red-600';
                  } else if (user.role === 'Head') {
                    roleClass = 'bg-purple-50 border-purple-100 text-purple-650';
                  }

                  return (
                    <tr key={user._id} className="hover:bg-slate-50 transition-colors duration-150">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="w-9 h-9 bg-indigo-50 border border-indigo-100 rounded-full flex items-center justify-center text-indigo-600 font-extrabold text-sm shrink-0">
                            {initials}
                          </div>
                          <div className="ml-3">
                            <p className="text-sm font-bold text-slate-800">
                              {user.name}
                              {isSelf && <span className="ml-2 text-[10px] bg-slate-105 border border-slate-200 text-slate-500 px-2 py-0.5 rounded-full font-normal">(You)</span>}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-slate-600">
                        {user.email}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${roleClass}`}>
                          {user.role}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right space-x-3">
                        <button
                          onClick={() => openEditModal(user)}
                          className="text-indigo-600 hover:text-indigo-700 text-sm font-semibold transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => openDeleteModal(user._id)}
                          disabled={isSelf}
                          className={`text-sm font-semibold transition-colors ${
                            isSelf
                              ? 'text-slate-300 cursor-not-allowed'
                              : 'text-red-500 hover:text-red-600'
                          }`}
                          title={isSelf ? 'Cannot delete own account' : 'Delete user'}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add User Modal */}
      {isAddOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px] p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 relative shadow-2xl animate-fade-in my-8 max-h-[90vh] overflow-y-auto select-none">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-slate-805">Add New User</h3>
                <p className="text-xs text-slate-500 mt-1">Create a new Head or Employee account</p>
              </div>
              <button onClick={() => setIsAddOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <form onSubmit={handleAddUser} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  placeholder="John Doe"
                  className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                  value={newUser.name}
                  onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  placeholder="john@example.com"
                  className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Password</label>
                <input
                  type="password"
                  required
                  placeholder="••••••••"
                  className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Role</label>
                <select
                  className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-505 text-sm transition-all duration-200"
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                >
                  <option value="Employee">Employee</option>
                  <option value="Head">Head</option>
                </select>
              </div>

              <div className="flex space-x-3 pt-4 border-t border-slate-100 mt-6">
                <button
                  type="button"
                  onClick={() => setIsAddOpen(false)}
                  className="w-1/2 py-3 px-4 border border-slate-200 hover:bg-slate-50 rounded-xl text-sm font-semibold text-slate-500 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="w-1/2 py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center space-x-2 shadow-md hover:translate-y-[-2px] active:translate-y-0"
                >
                  {actionLoading ? (
                    <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    'Add User'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {isEditOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px] p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 relative shadow-2xl animate-fade-in my-8 max-h-[90vh] overflow-y-auto select-none">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-slate-805">Edit User</h3>
                <p className="text-xs text-slate-500 mt-1">Update user profile information</p>
              </div>
              <button onClick={() => setIsEditOpen(false)} className="text-slate-400 hover:text-slate-655 transition-colors">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <form onSubmit={handleEditUser} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                  value={editUser.name}
                  onChange={(e) => setEditUser({ ...editUser, name: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Email Address</label>
                <input
                  type="email"
                  required
                  className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                  value={editUser.email}
                  onChange={(e) => setEditUser({ ...editUser, email: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Role</label>
                <select
                  className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-805 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-505 text-sm transition-all duration-200"
                  value={editUser.role}
                  onChange={(e) => setEditUser({ ...editUser, role: e.target.value })}
                >
                  <option value="Employee">Employee</option>
                  <option value="Head">Head</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>

              <div className="flex space-x-3 pt-4 border-t border-slate-100 mt-6">
                <button
                  type="button"
                  onClick={() => setIsEditOpen(false)}
                  className="w-1/2 py-3 px-4 border border-slate-200 hover:bg-slate-50 rounded-xl text-sm font-semibold text-slate-500 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="w-1/2 py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center space-x-2 shadow-md hover:translate-y-[-2px] active:translate-y-0"
                >
                  {actionLoading ? (
                    <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    'Save Changes'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {isDeleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[4px] p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-sm w-full p-6 relative shadow-2xl animate-fade-in select-none">
            <div className="w-12 h-12 mx-auto bg-red-50 border border-red-100 rounded-full flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            
            <h3 className="text-lg font-bold text-slate-800 text-center mb-2">Delete User</h3>
            <p className="text-xs text-slate-500 text-center mb-6">
              Are you sure you want to delete this user? This action cannot be undone.
            </p>

            <div className="flex space-x-3 pt-4 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setIsDeleteOpen(false)}
                className="w-1/2 py-3 px-4 border border-slate-200 hover:bg-slate-50 rounded-xl text-sm font-semibold text-slate-500 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteUser}
                disabled={actionLoading}
                className="w-1/2 py-3 px-4 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center space-x-2 shadow-md hover:translate-y-[-2px] active:translate-y-0"
              >
                {actionLoading ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
};

export default ManageUsers;
