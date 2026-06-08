import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/axios';

const Register = () => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('Employee'); // Default role
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      await api.post('/auth/register', {
        name,
        email,
        password,
        role
      });
      
      setSuccess('Account created successfully! Redirecting to login...');
      
      // Redirect to login after 2 seconds
      setTimeout(() => {
        navigate('/login');
      }, 2000);
    } catch (err) {
      console.error('Registration error:', err);
      const message = err.response?.data?.message || 'Registration failed. Please check your details.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-white font-sans overflow-hidden select-none">
      {/* Left half: Decorative Indigo Gradient (hidden on mobile) */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-tr from-indigo-600 via-indigo-500 to-violet-600 relative items-center justify-center p-12 overflow-hidden">
        {/* Floating circles decoration */}
        <div className="absolute top-12 left-12 h-32 w-32 bg-white/10 rounded-full blur-xl animate-pulse" />
        <div className="absolute bottom-16 right-16 h-48 w-48 bg-white/5 rounded-full blur-2xl animate-pulse delay-700" />
        <div className="absolute top-1/2 left-1/3 h-56 w-56 bg-indigo-400/20 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 max-w-md text-white text-center space-y-6">
          <div className="mx-auto h-16 w-16 rounded-2xl bg-white/10 backdrop-blur-md flex items-center justify-center shadow-2xl border border-white/20">
            <svg className="h-8 w-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
            </svg>
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight">Create Account</h1>
          <p className="text-white/80 leading-relaxed text-sm">
            Join the Central Email & Task Manager to collaborate across workspace operations.
          </p>
        </div>
      </div>

      {/* Right half: Form card (full screen on mobile) */}
      <div className="w-full lg:w-1/2 flex items-center justify-center px-6 sm:px-12 lg:px-20 bg-slate-50/50">
        <div className="max-w-md w-full space-y-8 bg-white p-8 sm:p-10 rounded-3xl shadow-xl border border-slate-100 relative">
          <div>
            <div className="mx-auto lg:mx-0 h-10 w-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-black text-sm shadow-md shadow-indigo-600/15 mb-6">
              CE
            </div>
            <h2 className="text-2xl font-bold text-slate-800 tracking-tight">
              Register
            </h2>
            <p className="mt-1.5 text-xs text-slate-400">
              Create your profile details to configure access.
            </p>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-100 text-red-500 p-4 rounded-xl text-xs flex items-start space-x-2 animate-shake">
              <svg className="h-4 w-4 shrink-0 mt-0.5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="bg-emerald-50 border border-emerald-100 text-emerald-600 p-4 rounded-xl text-xs flex items-start space-x-2">
              <svg className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{success}</span>
            </div>
          )}

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="name" className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                Full Name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                className="mt-1 block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-850 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 transition-all duration-150 text-xs"
                placeholder="John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                Email Address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className="mt-1 block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-850 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 transition-all duration-150 text-xs"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                className="mt-1 block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-850 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 transition-all duration-150 text-xs"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="role" className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                Workspace Role
              </label>
              <select
                id="role"
                name="role"
                className="mt-1 block w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-850 focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 transition-all duration-150 text-xs"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="Employee">Employee</option>
                <option value="Head">Head</option>
                <option value="Admin">Admin</option>
              </select>
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center py-3.5 px-4 border border-transparent text-xs font-semibold rounded-xl text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-indigo-600/10 hover:shadow-lg active:scale-[0.98]"
              >
                {loading ? 'Registering...' : 'Register'}
              </button>
            </div>
          </form>

          <div className="text-center mt-6">
            <p className="text-xs text-slate-455">
              Already have an account?{' '}
              <Link to="/login" className="font-semibold text-indigo-650 hover:text-indigo-700 transition-colors">
                Sign In
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Register;
