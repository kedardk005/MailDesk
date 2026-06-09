import React, { useState, useEffect } from 'react';
import api from '../api/axios';

const Profile = () => {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [alert, setAlert] = useState({ type: '', message: '' });
  const [gmailStatus, setGmailStatus] = useState({ connected: false, email: '' });
  const [connectingGmail, setConnectingGmail] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phoneNumber: '',
    birthdate: ''
  });

  useEffect(() => {
    fetchProfile();
  }, []);

  const triggerAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => {
      setAlert({ type: '', message: '' });
    }, 4500);
  };

  const fetchProfile = async () => {
    setLoading(true);
    try {
      const res = await api.get('/auth/me');
      setProfile(res.data);
      setFormData({
        name: res.data.name || '',
        email: res.data.email || '',
        phoneNumber: res.data.phoneNumber || '',
        birthdate: res.data.birthdate ? new Date(res.data.birthdate).toISOString().split('T')[0] : ''
      });
      // Sync local storage
      localStorage.setItem('user', JSON.stringify(res.data));

      if (res.data.role === 'Admin' || res.data.role === 'Head') {
        fetchGmailStatus();
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
      triggerAlert('error', 'Failed to retrieve profile data.');
    } finally {
      setLoading(false);
    }
  };

  const fetchGmailStatus = async () => {
    try {
      const res = await api.get('/gmail/status');
      setGmailStatus(res.data);
    } catch (err) {
      console.error('Error checking Gmail status:', err);
    }
  };

  const handleConnectGmail = async () => {
    setConnectingGmail(true);
    try {
      const res = await api.get('/gmail/auth-url');
      if (res.data.authUrl) {
        window.location.href = res.data.authUrl;
      } else {
        triggerAlert('error', 'Failed to acquire authorization portal link.');
      }
    } catch (err) {
      console.error('Gmail Auth error:', err);
      triggerAlert('error', err.response?.data?.message || 'Failed to authenticate Google credentials.');
    } finally {
      setConnectingGmail(false);
    }
  };

  const handleDisconnectGmail = async () => {
    if (!window.confirm('Are you sure you want to disconnect your Gmail sync? This will remove all fetched emails and task associations.')) {
      return;
    }
    try {
      await api.delete('/gmail/disconnect');
      setGmailStatus({ connected: false, email: '' });
      triggerAlert('success', 'Gmail account disconnected successfully.');
      fetchProfile();
    } catch (err) {
      console.error('Disconnect failed:', err);
      triggerAlert('error', 'Failed to unlink Gmail connection.');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setAlert({ type: '', message: '' });

    try {
      const res = await api.put('/users/profile', formData);
      setProfile(res.data);
      localStorage.setItem('user', JSON.stringify(res.data));
      
      // Dispatch custom storage event to update Sidebar profile data immediately
      window.dispatchEvent(new Event('storage'));
      
      triggerAlert('success', 'Profile records updated successfully!');
    } catch (err) {
      console.error('Profile update failed:', err);
      triggerAlert('error', err.response?.data?.message || 'Failed to update profile details.');
    } finally {
      setSaving(false);
    }
  };

  const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    try {
      const d = new Date(dateString);
      return d.toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });
    } catch (err) {
      return dateString;
    }
  };

  if (loading) {
    return (
      <main className="flex-grow max-w-4xl w-full mx-auto px-4 py-8 animate-fade-in select-none">
        <div className="h-40 bg-white border border-slate-200/80 rounded-3xl p-6 skeleton-shimmer mb-6" />
        <div className="h-96 bg-white border border-slate-200/80 rounded-3xl p-6 skeleton-shimmer" />
      </main>
    );
  }

  return (
    <main className="flex-grow max-w-4xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-fade-in select-none relative">
      {/* Floating Alert Banner */}
      {alert.message && (
        <div className={`fixed top-20 right-4 z-50 p-4 rounded-xl border flex items-start space-x-3 shadow-2xl transition-all duration-300 max-w-md animate-slide-in ${
          alert.type === 'success'
            ? 'bg-emerald-50 border-emerald-100 text-emerald-600'
            : 'bg-red-50 border-red-100 text-red-550'
        }`}>
          <svg className="h-5 w-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {alert.type === 'success' ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            )}
          </svg>
          <span className="text-xs font-semibold">{alert.message}</span>
        </div>
      )}

      {/* Profile Header Details Card */}
      <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm mb-6 flex flex-col sm:flex-row items-center gap-6">
        <div className="h-20 w-20 rounded-2xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white font-extrabold text-2xl shadow-lg shadow-indigo-600/10 shrink-0">
          {getInitials(profile?.name)}
        </div>
        <div className="text-center sm:text-left min-w-0">
          <h2 className="text-2xl font-black text-slate-800 tracking-tight leading-none mb-2">{profile?.name}</h2>
          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2.5">
            <span className="text-[10px] font-extrabold tracking-wider bg-indigo-50 text-indigo-650 px-3 py-1 rounded-full border border-indigo-100 uppercase">
              {profile?.role}
            </span>
            <span className="text-xs text-slate-400 font-medium">
              Registered on: {formatDate(profile?.createdAt)}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Profile Settings Form Card */}
        <div className="md:col-span-2 bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-1">Account Information</h3>
          <p className="text-xs text-slate-400 mb-6">Edit your name, birthday, and contact profile.</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Full Name</label>
              <input
                type="text"
                required
                className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Email Address</label>
              <input
                type="email"
                required
                className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Birthdate</label>
                <input
                  type="date"
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200 cursor-pointer"
                  value={formData.birthdate}
                  onChange={(e) => setFormData({ ...formData, birthdate: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Phone Number</label>
                <input
                  type="tel"
                  placeholder="e.g. +1 555-0199"
                  className="block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-150 focus:border-indigo-500 text-sm transition-all duration-200"
                  value={formData.phoneNumber}
                  onChange={(e) => setFormData({ ...formData, phoneNumber: e.target.value })}
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Account Role</label>
              <input
                type="text"
                disabled
                className="block w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-450 text-sm cursor-not-allowed select-none"
                value={profile?.role || ''}
              />
              <span className="text-[10px] text-slate-400 mt-1 block">Roles are managed by your administrator.</span>
            </div>

            <div className="pt-4 border-t border-slate-100 flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-xs font-bold text-white rounded-xl shadow-md shadow-indigo-600/10 hover:shadow-indigo-600/20 active:scale-[0.98] transition-all disabled:opacity-50"
              >
                {saving ? 'Saving changes...' : 'Save Profile Details'}
              </button>
            </div>
          </form>
        </div>

        {/* Gmail Sync Management Panel Card */}
        <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm flex flex-col justify-between">
          <div>
            <h3 className="text-lg font-bold text-slate-800 mb-1">Google Workspace</h3>
            <p className="text-xs text-slate-400 mb-6">Manage connected Gmail synchronization credentials.</p>

            {(profile?.role === 'Admin' || profile?.role === 'Head') ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className={`w-3.5 h-3.5 rounded-full shrink-0 ${gmailStatus.connected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
                  <span className="text-xs font-bold text-slate-700">
                    {gmailStatus.connected ? 'Gmail Sync Connected' : 'Google Sync Offline'}
                  </span>
                </div>

                {gmailStatus.connected && (
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-0.5">Inbox Address</span>
                    <span className="text-xs font-semibold text-slate-700 block truncate">{gmailStatus.email}</span>
                  </div>
                )}

                <p className="text-[10px] leading-relaxed text-slate-500">
                  {gmailStatus.connected
                    ? 'Your Gmail account is linked. Emails are successfully indexed and automatically populated in the workspace Inbox.'
                    : 'Link a Gmail inbox account. Connecting enables manual syncing and automatic periodic processing.'}
                </p>
              </div>
            ) : (
              <div className="bg-slate-50 p-4 border border-slate-100 rounded-xl text-center">
                <span className="text-lg mb-1 block">🔒</span>
                <span className="text-xs font-bold text-slate-700 block">Workspace Restricted</span>
                <p className="text-[10px] text-slate-400 leading-relaxed mt-1">
                  Gmail indexing capabilities are restricted to Administators and Department Heads.
                </p>
              </div>
            )}
          </div>

          {(profile?.role === 'Admin' || profile?.role === 'Head') && (
            <div className="pt-6 border-t border-slate-100 mt-6">
              {gmailStatus.connected ? (
                <button
                  type="button"
                  onClick={handleDisconnectGmail}
                  className="w-full py-3 border border-red-200 hover:bg-red-50 text-red-650 hover:text-red-700 font-bold rounded-xl text-xs transition-colors"
                >
                  Disconnect Google Auth
                </button>
              ) : (
                <button
                  type="button"
                  disabled={connectingGmail}
                  onClick={handleConnectGmail}
                  className="w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 font-bold text-white rounded-xl text-xs shadow-md shadow-indigo-650/10 hover:shadow-indigo-650/20 active:scale-[0.98] transition-all disabled:opacity-50"
                >
                  {connectingGmail ? 'Routing to Google...' : 'Connect Gmail Account'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
};

export default Profile;
