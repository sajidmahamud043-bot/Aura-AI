import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { User, LogIn, LogOut, Mail, Lock, UserCircle, Shield, Globe, Terminal, Loader2, X } from 'lucide-react';
import { auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword } from '../lib/firebase';
import { cn } from '../lib/utils';

interface UserProfileProps {
  onClose: () => void;
  activeColor: string;
  activeText: string;
  activeBorder: string;
}

export default function UserProfile({ onClose, activeColor, activeText, activeBorder }: UserProfileProps) {
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState({ type: '', text: '' });
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (password.length < 6) {
      setMessage({ type: 'error', text: 'Password must be at least 6 characters.' });
      return;
    }

    setIsProcessing(true);
    setMessage({ type: '', text: '' });

    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(auth, email, password);
        setMessage({ type: 'success', text: 'Identity verified. Neural sync complete.' });
        setTimeout(() => onClose(), 1500);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
        setMessage({ type: 'success', text: 'Registration successful. Account created.' });
      }
    } catch (err: any) {
      console.error("Auth Error:", err);
      let errorMsg = err.message;
      if (errorMsg.includes('auth/invalid-credential')) errorMsg = 'Access Denied: Invalid credentials.';
      if (errorMsg.includes('auth/email-already-in-use')) errorMsg = 'Identity already exists. Try logging in.';
      
      setMessage({ type: 'error', text: errorMsg });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsProcessing(true);
    try {
      await signInWithPopup(auth, googleProvider);
      onClose();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    onClose();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin opacity-20" />
      </div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="p-6 space-y-8"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn("p-2 rounded-lg bg-opacity-20", activeColor)}>
            <UserCircle className={cn("w-5 h-5", activeText)} />
          </div>
          <h2 className="text-sm font-black uppercase tracking-[0.3em]">Profile</h2>
        </div>
        <button 
          onClick={onClose} 
          className="p-2 rounded-full hover:bg-white/10 text-white/40 hover:text-white transition-all active:scale-90"
          title="Exit Profile"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {!currentUser ? (
        <div className="space-y-6">
          <div className="flex p-1 bg-white/5 rounded-xl border border-white/5">
            <button 
              onClick={() => setAuthMode('login')}
              className={cn(
                "flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all",
                authMode === 'login' ? "bg-white/10 text-white" : "text-white/30"
              )}
            >
              Access
            </button>
            <button 
              onClick={() => setAuthMode('signup')}
              className={cn(
                "flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all",
                authMode === 'signup' ? "bg-white/10 text-white" : "text-white/30"
              )}
            >
              Register
            </button>
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-[0.2em] font-black opacity-30 px-1">Nexus ID (Email)</label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 opacity-30" />
                <input 
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-xs focus:border-white/20 transition-all outline-none"
                  placeholder="nexus@aura.io"
                  required
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-[0.2em] font-black opacity-30 px-1">Access Protocol (Password)</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 opacity-30" />
                <input 
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-xs focus:border-white/20 transition-all outline-none"
                  placeholder="••••••••"
                  required
                />
              </div>
            </div>

            {message.text && (
              <p className={cn(
                "text-[10px] font-bold text-center",
                message.type === 'error' ? "text-red-400" : "text-green-400"
              )}>
                {message.text}
              </p>
            )}

            <button 
              disabled={isProcessing}
              type="submit"
              className={cn(
                "w-full py-4 rounded-xl flex items-center justify-center gap-2 font-black uppercase tracking-[0.2em] text-[10px] transition-all hover:shadow-lg active:scale-95 disabled:opacity-50",
                activeColor,
                "text-white"
              )}
            >
              {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {authMode === 'login' ? 'Initiate Sync' : 'Register identity'}
            </button>
          </form>

          <div className="relative py-4 flex items-center gap-4">
            <div className="h-[1px] flex-1 bg-white/5" />
            <span className="text-[10px] font-black uppercase tracking-widest opacity-20">OR</span>
            <div className="h-[1px] flex-1 bg-white/5" />
          </div>

          <button 
            onClick={handleGoogleLogin}
            className="w-full py-4 rounded-xl border border-white/10 bg-white/5 flex items-center justify-center gap-3 font-black uppercase tracking-[0.2em] text-[10px] hover:bg-white/10 transition-all active:scale-95"
          >
            <Globe className="w-4 h-4" />
            Neural Link (Google)
          </button>

          <div className="p-3 rounded-xl bg-green-500/5 border border-green-500/10 flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            <p className="text-[9px] uppercase tracking-widest font-black text-green-500/60">Neural Link Stable</p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="p-6 rounded-2xl bg-white/5 border border-white/10 relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-30 transition-opacity">
              <Terminal className="w-12 h-12" />
            </div>
            
            <div className="relative flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-white/10 to-transparent flex items-center justify-center border border-white/10 overflow-hidden">
                {currentUser.photoURL ? (
                  <img src={currentUser.photoURL} alt="Profile" className="w-full h-full object-cover" />
                ) : (
                  <User className="w-8 h-8 opacity-20" />
                )}
              </div>
              <div>
                <h3 className="font-bold text-sm truncate">{currentUser.email}</h3>
                <p className="text-[10px] font-black uppercase tracking-widest opacity-30 mt-1">{currentUser.displayName || 'Neural Member'}</p>
                <div className="flex gap-2 mt-3">
                   <span className="px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 text-[8px] font-black uppercase tracking-widest border border-green-500/20">Active</span>
                   <span className="px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 text-[8px] font-black uppercase tracking-widest border border-cyan-500/20">Syncing</span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
             <div className="p-4 rounded-xl bg-white/5 border border-white/5 space-y-1">
                <p className="text-[9px] uppercase tracking-widest opacity-30 font-black">Identity Created</p>
                <p className="text-xs font-bold">{currentUser.metadata.creationTime ? new Date(currentUser.metadata.creationTime).toLocaleDateString() : 'N/A'}</p>
             </div>
             <div className="p-4 rounded-xl bg-white/5 border border-white/5 space-y-1">
                <p className="text-[9px] uppercase tracking-widest opacity-30 font-black">Security Clear</p>
                <p className="text-xs font-bold">Standard</p>
             </div>
          </div>

          <button 
            onClick={handleLogout}
            className="w-full py-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 font-black uppercase tracking-[0.2em] text-[10px] hover:bg-red-500/20 transition-all active:scale-95 flex items-center justify-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            Terminate Session
          </button>
        </div>
      )}
    </motion.div>
  );
}
