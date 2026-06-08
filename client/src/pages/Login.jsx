import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/axios';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await api.post('/auth/login', { email, password });
      
      // Save token and user to localStorage
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(response.data.user));
      
      // Redirect to dashboard
      navigate('/dashboard');
    } catch (err) {
      console.error('Login error:', err);
      const message = err.response?.data?.message || 'Login failed. Please check your credentials and try again.';
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight">Welcome Back</h1>
          <p className="text-white/80 leading-relaxed text-sm">
            Sign in to manage your emails & tasks inside the workspace central manager app.
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
              Sign In
            </h2>
            <p className="mt-1.5 text-xs text-slate-400">
              Welcome back. Enter your workspace details to continue.
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

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
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

            <div className="pt-2">
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center py-3.5 px-4 border border-transparent text-xs font-semibold rounded-xl text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-indigo-600/10 hover:shadow-lg active:scale-[0.98]"
              >
                {loading ? 'Signing In...' : 'Sign In'}
              </button>
            </div>
          </form>

          <div className="text-center mt-6">
            <p className="text-xs text-slate-455">
              Don't have an account?{' '}
              <Link to="/register" className="font-semibold text-indigo-650 hover:text-indigo-700 transition-colors">
                Create an account
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
