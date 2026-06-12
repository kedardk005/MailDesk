import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import CountUp from '../utils/countUp';
import { initTilt } from '../utils/tiltEffect';
import { initCursorEffects } from '../utils/cursorEffects';
import api from '../api/axios';

const Landing = () => {
  const navigate = useNavigate();
  const mockupRef = useRef(null);
  const featureCardRefs = useRef([]);
  featureCardRefs.current = [];

  const [stats, setStats] = useState({
    totalEmails: 1248,
    totalTasks: 340,
    totalCompleted: 892,
    totalLate: 8,
    totalUsers: 5,
    totalPending: 280
  });

  // Add refs for tilt effect
  const addToFeatureRefs = (el) => {
    if (el && !featureCardRefs.current.includes(el)) {
      featureCardRefs.current.push(el);
    }
  };

  useEffect(() => {
    // Initialize custom cursor effects locally on Landing page
    const cleanupCursor = initCursorEffects();

    // Fetch real-time statistics if logged in
    const fetchRealStats = async () => {
      const token = localStorage.getItem('token');
      if (token) {
        try {
          const res = await api.get('/reports/overall');
          setStats({
            totalEmails: res.data.totalEmails || 0,
            totalTasks: res.data.totalTasks || 0,
            totalCompleted: res.data.totalCompleted || 0,
            totalLate: res.data.totalLate || 0,
            totalUsers: res.data.totalUsers || 0,
            totalPending: res.data.totalPending || 0
          });
        } catch (err) {
          console.error("Failed to load real-time stats for landing:", err);
        }
      }
    };
    fetchRealStats();

    // Initialize tilt on Mockup
    let cleanupMockup = () => {};
    if (mockupRef.current) {
      cleanupMockup = initTilt(mockupRef.current, 6, 1200);
    }

    // Initialize tilt on Feature cards
    const cleanupsFeature = featureCardRefs.current.map((card) =>
      initTilt(card, 5, 800)
    );

    // Scroll reveal observer (simpler inline variant to ensure execution)
    const observerOptions = {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px',
    };

    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('active');
          revealObserver.unobserve(entry.target);
        }
      });
    }, observerOptions);

    const revealEls = document.querySelectorAll(
      '.reveal-on-scroll, .reveal-stagger-child > *'
    );
    revealEls.forEach((el) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(24px)';
      el.style.transition = 'opacity 0.8s cubic-bezier(0.23, 1, 0.32, 1), transform 0.8s cubic-bezier(0.23, 1, 0.32, 1)';
      revealObserver.observe(el);
    });

    // Handle scroll reveal logic
    const handleScrollReveal = () => {
      const activeEls = document.querySelectorAll('.reveal-on-scroll.active, .reveal-stagger-child > *.active');
      activeEls.forEach((el) => {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0px)';
      });
    };

    const interval = setInterval(handleScrollReveal, 100);

    return () => {
      if (cleanupCursor) cleanupCursor();
      cleanupMockup();
      cleanupsFeature.forEach((cleanup) => cleanup());
      revealObserver.disconnect();
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="min-h-screen bg-white text-slate-900 font-sans selection:bg-indigo-500 selection:text-white relative overflow-x-hidden">
      
      {/* Navbar overlay for landing */}
      <header className="fixed top-0 left-0 right-0 h-20 bg-white/80 backdrop-blur-md border-b border-slate-100 z-50 flex items-center justify-between px-6 sm:px-12 transition-all duration-200">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white shadow-md shadow-indigo-600/20 shrink-0">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
              <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
          </div>
          <span className="font-extrabold text-lg text-slate-900 tracking-tight leading-none">
            MailDesk
          </span>
        </div>
        
        <div className="flex items-center gap-4">
          <Link to="/login" className="text-xs font-bold text-slate-600 hover:text-slate-900 transition-all duration-150 px-4 py-2.5 rounded-xl hover:bg-slate-50">
            Sign In
          </Link>
          <Link to="/register" className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-xs font-bold px-5 py-2.5 rounded-xl transition-all duration-150 shadow-md shadow-indigo-600/10 hover:shadow-indigo-600/20 hover:scale-[1.02] active:scale-95">
            Get Started
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative min-h-screen pt-36 pb-20 flex flex-col items-center justify-center bg-white overflow-hidden dot-grid">
        {/* Soft Background Blobs */}
        <div className="absolute top-20 left-10 w-[400px] h-[400px] bg-indigo-500/10 rounded-full blur-[100px] animate-blob pointer-events-none" />
        <div className="absolute top-40 right-10 w-[450px] h-[450px] bg-purple-500/10 rounded-full blur-[100px] animate-blob pointer-events-none" style={{ animationDelay: '5s' }} />
        <div className="absolute bottom-10 left-1/3 w-[500px] h-[500px] bg-pink-500/10 rounded-full blur-[120px] animate-blob pointer-events-none" style={{ animationDelay: '10s' }} />

        {/* Content Container */}
        <div className="max-w-5xl mx-auto px-6 text-center z-10 flex flex-col items-center">
          
          {/* Top Badge */}
          <div className="animate-[fadeInDown_0.6s_ease-out_forwards] inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-indigo-100 bg-indigo-50 text-indigo-600 text-xs sm:text-sm font-semibold mb-8 shadow-sm">
            <span>✦</span> Gmail Integrated · Real-time · Role Based
          </div>

          {/* Staggered Heading */}
          <h1 className="text-5xl sm:text-7xl lg:text-8xl font-black tracking-tighter leading-[0.9] text-slate-900 flex flex-col gap-2">
            <span className="opacity-0 animate-[fadeInUp_0.6s_cubic-bezier(0.23,1,0.32,1)_forwards] [animation-delay:100ms]">
              Manage Emails.
            </span>
            <span className="opacity-0 animate-[fadeInUp_0.6s_cubic-bezier(0.23,1,0.32,1)_forwards] [animation-delay:180ms]">
              Assign Tasks.
            </span>
            <span className="opacity-0 animate-[fadeInUp_0.6s_cubic-bezier(0.23,1,0.32,1)_forwards] [animation-delay:260ms] bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500 bg-clip-text text-transparent pb-3">
              Move Fast.
            </span>
          </h1>

          {/* Subheading */}
          <p className="opacity-0 animate-[fadeInUp_0.8s_cubic-bezier(0.23,1,0.32,1)_forwards] [animation-delay:400ms] text-lg sm:text-xl text-slate-500 max-w-2xl mx-auto leading-relaxed mt-6">
            MailDesk centralizes your company Gmail accounts, lets managers assign tasks directly from emails, and keeps your entire team in sync — in real time.
          </p>

          {/* CTA Row */}
          <div className="opacity-0 animate-[fadeInUp_0.8s_cubic-bezier(0.23,1,0.32,1)_forwards] [animation-delay:600ms] mt-10 flex flex-col sm:flex-row gap-4 justify-center items-center w-full">
            <Link
              to="/register"
              className="w-full sm:w-auto bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-semibold rounded-2xl px-8 py-4 text-base shadow-[0_0_40px_rgba(99,102,241,0.4)] hover:shadow-[0_0_50px_rgba(99,102,241,0.5)] hover:-translate-y-0.5 transition-all duration-200 text-center"
            >
              Start for Free →
            </Link>
            <Link
              to="/login"
              className="w-full sm:w-auto bg-white text-slate-800 font-semibold border border-slate-200 rounded-2xl px-8 py-4 text-base hover:border-indigo-300 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 text-center"
            >
              See a Demo
            </Link>
          </div>

          {/* Social Proof */}
          <div className="opacity-0 animate-[fadeInUp_0.8s_cubic-bezier(0.23,1,0.32,1)_forwards] [animation-delay:800ms] mt-10 flex items-center justify-center gap-3">
            <div className="flex -space-x-2.5">
              <span className="w-8 h-8 rounded-full border-2 border-white bg-indigo-500 flex items-center justify-center text-[10px] text-white font-bold">JD</span>
              <span className="w-8 h-8 rounded-full border-2 border-white bg-purple-500 flex items-center justify-center text-[10px] text-white font-bold">AS</span>
              <span className="w-8 h-8 rounded-full border-2 border-white bg-pink-500 flex items-center justify-center text-[10px] text-white font-bold">MK</span>
              <span className="w-8 h-8 rounded-full border-2 border-white bg-emerald-500 flex items-center justify-center text-[10px] text-white font-bold">TL</span>
              <span className="w-8 h-8 rounded-full border-2 border-white bg-amber-500 flex items-center justify-center text-[10px] text-white font-bold">RH</span>
            </div>
            <span className="text-sm font-medium text-slate-500">Trusted by 500+ teams worldwide</span>
          </div>

          {/* 3D Dashboard Preview */}
          <div className="opacity-0 animate-[fadeInUp_1s_cubic-bezier(0.23,1,0.32,1)_forwards] [animation-delay:950ms] mt-20 w-full max-w-4xl relative perspective-1200 hover:scale-[1.01] transition-transform duration-500">
            
            <div
              ref={mockupRef}
              className="animate-float w-full bg-white rounded-3xl border border-slate-100 shadow-[0_40px_100px_rgba(99,102,241,0.22)] overflow-hidden text-left"
              style={{ transform: 'rotateX(12deg)' }}
            >
              
              {/* Fake Top Bar */}
              <div className="h-14 border-b border-slate-100 bg-slate-50/50 px-6 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-6 w-6 rounded-lg bg-indigo-600 flex items-center justify-center text-white shrink-0">
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
                      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                    </svg>
                  </div>
                  <span className="font-extrabold text-xs text-slate-900 tracking-tight">MailDesk</span>
                  <div className="hidden sm:flex items-center gap-4 ml-8 text-[11px] font-bold text-slate-500">
                    <span className="text-indigo-600">Dashboard</span>
                    <span>Inbox</span>
                    <span>Tasks</span>
                    <span>Reports</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  <div className="h-7 w-7 rounded-full bg-indigo-100 border border-indigo-200 flex items-center justify-center text-[10px] text-indigo-700 font-bold">CE</div>
                </div>
              </div>

              {/* Mockup Inner Body */}
              <div className="p-6 space-y-6">
                
                {/* 4 Stat Cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="p-4 bg-slate-50/60 border border-slate-100 rounded-2xl flex flex-col">
                    <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">Incoming Mails</span>
                    <span className="text-2xl font-black text-slate-800 mt-1">{stats.totalEmails.toLocaleString()}</span>
                    <span className="text-[9px] font-bold text-emerald-600 mt-1">↑ 12% this week</span>
                  </div>
                  <div className="p-4 bg-slate-50/60 border border-slate-100 rounded-2xl flex flex-col">
                    <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">Assigned Tasks</span>
                    <span className="text-2xl font-black text-slate-800 mt-1">{stats.totalTasks.toLocaleString()}</span>
                    <span className="text-[9px] font-bold text-indigo-600 mt-1">↑ 4 active now</span>
                  </div>
                  <div className="p-4 bg-slate-50/60 border border-slate-100 rounded-2xl flex flex-col">
                    <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">Resolved Tasks</span>
                    <span className="text-2xl font-black text-slate-800 mt-1">{stats.totalCompleted.toLocaleString()}</span>
                    <span className="text-[9px] font-bold text-purple-600 mt-1">94% completion rate</span>
                  </div>
                  <div className="p-4 bg-slate-50/60 border border-slate-100 rounded-2xl flex flex-col">
                    <span className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">Overdue Tasks</span>
                    <span className="text-2xl font-black text-slate-800 mt-1">{stats.totalLate.toLocaleString()}</span>
                    <span className="text-[9px] font-bold text-red-500 mt-1">↓ 3 from yesterday</span>
                  </div>
                </div>

                {/* Table representation */}
                <div className="border border-slate-100 rounded-2xl overflow-hidden bg-white">
                  <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-100 flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-700">Recent Sync Emails</span>
                    <span className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-bold">Updated Just Now</span>
                  </div>
                  <div className="divide-y divide-slate-50">
                    <div className="px-4 py-3 flex items-center justify-between text-xs hover:bg-slate-50/50 transition-colors">
                      <div className="flex items-center gap-3">
                        <span className="w-2 h-2 rounded-full bg-indigo-600" />
                        <span className="font-bold text-slate-700">Google Workspace Admin</span>
                        <span className="text-slate-400 truncate max-w-xs sm:max-w-md">Urgent: Review billing changes for enterprise operations...</span>
                      </div>
                      <span className="text-[10px] bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full font-bold">Assigned</span>
                    </div>
                    <div className="px-4 py-3 flex items-center justify-between text-xs hover:bg-slate-50/50 transition-colors">
                      <div className="flex items-center gap-3">
                        <span className="w-2 h-2 rounded-full bg-slate-200" />
                        <span className="font-bold text-slate-700">Sarah Jenkins (Client)</span>
                        <span className="text-slate-400 truncate max-w-xs sm:max-w-md">Feedback on recent UI deployment prototypes...</span>
                      </div>
                      <span className="text-[10px] bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full font-bold">Completed</span>
                    </div>
                    <div className="px-4 py-3 flex items-center justify-between text-xs hover:bg-slate-50/50 transition-colors">
                      <div className="flex items-center gap-3">
                        <span className="w-2 h-2 rounded-full bg-indigo-600" />
                        <span className="font-bold text-slate-700">DevOps Alert</span>
                        <span className="text-slate-400 truncate max-w-xs sm:max-w-md">Warning: Server CPU usage exceeded 85% on node-2a...</span>
                      </div>
                      <span className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-bold">Pending</span>
                    </div>
                  </div>
                </div>

              </div>

              {/* White Fade gradient cover at bottom */}
              <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-white to-transparent pointer-events-none" />
            </div>

          </div>

        </div>
      </section>

      {/* Stats Section */}
      <section className="bg-white border-y border-slate-100 py-16 reveal-on-scroll">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 text-center items-center">
            
            <div className="flex flex-col items-center">
              <span className="text-4xl sm:text-5xl font-black text-slate-900 leading-none">
                <CountUp end={stats.totalEmails} suffix="+" />
              </span>
              <span className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">Emails Synced</span>
            </div>

            <div className="hidden lg:block h-12 w-[1px] bg-slate-100" />

            <div className="flex flex-col items-center">
              <span className="text-4xl sm:text-5xl font-black text-slate-900 leading-none">
                <CountUp end={stats.totalTasks} />
              </span>
              <span className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">Tasks Assigned</span>
            </div>

            <div className="hidden lg:block h-12 w-[1px] bg-slate-100" />

            <div className="flex flex-col items-center">
              <span className="text-4xl sm:text-5xl font-black text-slate-900 leading-none">
                <CountUp end={stats.totalCompleted} />
              </span>
              <span className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">Tasks Completed</span>
            </div>

            <div className="hidden lg:block h-12 w-[1px] bg-slate-100" />

            <div className="flex flex-col items-center">
              <span className="text-4xl sm:text-5xl font-black text-slate-900 leading-none">
                <CountUp end={stats.totalUsers} />
              </span>
              <span className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-widest mt-2">Active Users</span>
            </div>

          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-28 bg-white max-w-6xl mx-auto px-6 reveal-on-scroll">
        <div className="text-center sm:text-left flex flex-col justify-between items-start gap-4 mb-20">
          <span className="text-xs font-bold tracking-widest text-indigo-500 uppercase">
            Features
          </span>
          <h2 className="text-4xl sm:text-5xl font-black tracking-tight text-slate-900 leading-tight">
            Built for how teams actually work
          </h2>
          <p className="text-base text-slate-500 max-w-xl">
            Everything you need to turn raw client emails into action items, assign them across staff, and monitor performance in one place.
          </p>
        </div>

        {/* Feature Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-16 reveal-stagger-child">
          
          {/* Card 1 */}
          <div
            ref={addToFeatureRefs}
            className="bg-white rounded-[2.5rem] p-8 border border-slate-200/80 hover:border-indigo-200 hover:-translate-y-2 hover:shadow-[0_20px_60px_rgba(99,102,241,0.12)] transition-all duration-500 flex flex-col justify-between min-h-[300px]"
          >
            <div>
              <div className="h-14 w-14 rounded-2xl bg-indigo-50 flex items-center justify-center text-2xl shadow-sm mb-6">
                📧
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-3">Centralized Gmail Inbox</h3>
              <p className="text-slate-500 leading-relaxed text-sm">
                Connect multiple Gmail accounts. All emails flow into one smart inbox. Never miss a client message again.
              </p>
            </div>
            <Link to="/login" className="text-indigo-600 hover:text-indigo-700 text-sm font-bold mt-6 inline-flex items-center gap-1">
              Learn more <span className="transition-transform group-hover:translate-x-1">→</span>
            </Link>
          </div>

          {/* Card 2 */}
          <div
            ref={addToFeatureRefs}
            className="bg-white rounded-[2.5rem] p-8 border border-slate-200/80 hover:border-indigo-200 hover:-translate-y-2 hover:shadow-[0_20px_60px_rgba(99,102,241,0.12)] transition-all duration-500 flex flex-col justify-between min-h-[300px]"
          >
            <div>
              <div className="h-14 w-14 rounded-2xl bg-indigo-50 flex items-center justify-center text-2xl shadow-sm mb-6">
                ✅
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-3">Email-to-Task in One Click</h3>
              <p className="text-slate-500 leading-relaxed text-sm">
                Turn any email into an assigned task instantly. Set deadlines, add notes, and link the original email thread for full context.
              </p>
            </div>
            <Link to="/login" className="text-indigo-600 hover:text-indigo-700 text-sm font-bold mt-6 inline-flex items-center gap-1">
              Learn more <span className="transition-transform group-hover:translate-x-1">→</span>
            </Link>
          </div>

          {/* Card 3 */}
          <div
            ref={addToFeatureRefs}
            className="bg-white rounded-[2.5rem] p-8 border border-slate-200/80 hover:border-indigo-200 hover:-translate-y-2 hover:shadow-[0_20px_60px_rgba(99,102,241,0.12)] transition-all duration-500 flex flex-col justify-between min-h-[300px]"
          >
            <div>
              <div className="h-14 w-14 rounded-2xl bg-indigo-50 flex items-center justify-center text-2xl shadow-sm mb-6">
                🔔
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-3">Real-time Notifications</h3>
              <p className="text-slate-500 leading-relaxed text-sm">
                Socket.io powered live alerts inside the app. Email notifications via Gmail when offline. Your team stays in sync instantly.
              </p>
            </div>
            <Link to="/login" className="text-indigo-600 hover:text-indigo-700 text-sm font-bold mt-6 inline-flex items-center gap-1">
              Learn more <span className="transition-transform group-hover:translate-x-1">→</span>
            </Link>
          </div>

          {/* Card 4 */}
          <div
            ref={addToFeatureRefs}
            className="bg-white rounded-[2.5rem] p-8 border border-slate-200/80 hover:border-indigo-200 hover:-translate-y-2 hover:shadow-[0_20px_60px_rgba(99,102,241,0.12)] transition-all duration-500 flex flex-col justify-between min-h-[300px]"
          >
            <div>
              <div className="h-14 w-14 rounded-2xl bg-indigo-50 flex items-center justify-center text-2xl shadow-sm mb-6">
                🛡️
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-3">Role-based Access</h3>
              <p className="text-slate-500 leading-relaxed text-sm">
                Admin, Head, Employee — each role sees exactly what they need. Manage users, assign mail workflows, or execute tasks seamlessly.
              </p>
            </div>
            <Link to="/login" className="text-indigo-600 hover:text-indigo-700 text-sm font-bold mt-6 inline-flex items-center gap-1">
              Learn more <span className="transition-transform group-hover:translate-x-1">→</span>
            </Link>
          </div>

          {/* Card 5 */}
          <div
            ref={addToFeatureRefs}
            className="bg-white rounded-[2.5rem] p-8 border border-slate-200/80 hover:border-indigo-200 hover:-translate-y-2 hover:shadow-[0_20px_60px_rgba(99,102,241,0.12)] transition-all duration-500 flex flex-col justify-between min-h-[300px]"
          >
            <div>
              <div className="h-14 w-14 rounded-2xl bg-indigo-50 flex items-center justify-center text-2xl shadow-sm mb-6">
                ⏱️
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-3">Deadline Tracking</h3>
              <p className="text-slate-500 leading-relaxed text-sm">
                Automatic background system monitors all deadlines. Tasks change status to late automatically and trigger warnings.
              </p>
            </div>
            <Link to="/login" className="text-indigo-600 hover:text-indigo-700 text-sm font-bold mt-6 inline-flex items-center gap-1">
              Learn more <span className="transition-transform group-hover:translate-x-1">→</span>
            </Link>
          </div>

          {/* Card 6 */}
          <div
            ref={addToFeatureRefs}
            className="bg-white rounded-[2.5rem] p-8 border border-slate-200/80 hover:border-indigo-200 hover:-translate-y-2 hover:shadow-[0_20px_60px_rgba(99,102,241,0.12)] transition-all duration-500 flex flex-col justify-between min-h-[300px]"
          >
            <div>
              <div className="h-14 w-14 rounded-2xl bg-indigo-50 flex items-center justify-center text-2xl shadow-sm mb-6">
                📊
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-3">Team Analytics</h3>
              <p className="text-slate-500 leading-relaxed text-sm">
                Weekly and monthly performance reports. Track task completion rates per employee and export data to CSV reports in one click.
              </p>
            </div>
            <Link to="/login" className="text-indigo-600 hover:text-indigo-700 text-sm font-bold mt-6 inline-flex items-center gap-1">
              Learn more <span className="transition-transform group-hover:translate-x-1">→</span>
            </Link>
          </div>

        </div>
      </section>

      {/* How It Works Section */}
      <section className="py-24 bg-slate-50/50 rounded-[2.5rem] mx-6 my-10 reveal-on-scroll">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <span className="text-xs font-bold tracking-widest text-indigo-500 uppercase">
            How It Works
          </span>
          <h2 className="text-3xl sm:text-4xl font-black text-slate-900 mt-3 mb-16">
            Three steps to full control
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-12 relative">
            
            {/* Dashed line spacer (desktop only) */}
            <div className="hidden md:block absolute top-6 left-1/6 right-1/6 h-[2px] border-t-2 border-dashed border-indigo-100 -z-10" style={{ width: '66.6%' }} />

            {/* Step 1 */}
            <div className="flex flex-col items-center text-center px-4">
              <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 text-white font-extrabold flex items-center justify-center shadow-md shadow-indigo-600/20 mb-5">
                1
              </div>
              <h3 className="font-bold text-lg text-slate-900 mb-2">Connect Gmail</h3>
              <p className="text-slate-400 text-sm leading-relaxed max-w-[240px]">
                OAuth in one click. All emails sync into the workspace automatically.
              </p>
            </div>

            {/* Step 2 */}
            <div className="flex flex-col items-center text-center px-4">
              <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 text-white font-extrabold flex items-center justify-center shadow-md shadow-indigo-600/20 mb-5">
                2
              </div>
              <h3 className="font-bold text-lg text-slate-900 mb-2">Assign & Track</h3>
              <p className="text-slate-400 text-sm leading-relaxed max-w-[240px]">
                Turn emails into tasks. Set deadlines. Assign to your team instantly.
              </p>
            </div>

            {/* Step 3 */}
            <div className="flex flex-col items-center text-center px-4">
              <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 text-white font-extrabold flex items-center justify-center shadow-md shadow-indigo-600/20 mb-5">
                3
              </div>
              <h3 className="font-bold text-lg text-slate-900 mb-2">Analyze & Improve</h3>
              <p className="text-slate-400 text-sm leading-relaxed max-w-[240px]">
                Weekly reports show who's on track. Export analytics to CSV anytime.
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* CTA Banner Section */}
      <section className="py-24 mx-6 rounded-[2.5rem] bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 text-white text-center relative overflow-hidden shadow-2xl reveal-on-scroll">
        {/* Decorative noise/gradient circles */}
        <div className="absolute top-1/2 left-10 w-96 h-96 bg-white/5 rounded-full blur-2xl pointer-events-none" />
        <div className="absolute bottom-0 right-12 w-64 h-64 bg-white/5 rounded-full blur-xl pointer-events-none" />

        <div className="max-w-3xl mx-auto px-6 relative z-10">
          <h2 className="text-4xl sm:text-5xl font-black mb-4">Your inbox is waiting.</h2>
          <p className="text-white/70 text-lg mb-10 max-w-xl mx-auto">
            Join teams already using MailDesk to stay organized, delegate client communications, and complete workflows on time.
          </p>
          <Link
            to="/register"
            className="inline-block bg-white text-indigo-700 font-bold rounded-2xl px-10 py-4 shadow-xl hover:scale-105 active:scale-95 transition-all duration-200"
          >
            Create Your Account
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 py-12 px-6 sm:px-12 mt-10">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex flex-col items-center md:items-start gap-1">
            <span className="font-extrabold text-slate-900 text-base">MailDesk</span>
            <span className="text-xs text-slate-400">Where Emails Meet Action.</span>
          </div>
        </div>
      </footer>

    </div>
  );
};

export default Landing;
