import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { ShieldCheck, Users, Search, Trash2, ShieldAlert, X, Shield, Settings2, Database, Trash, Ban, LayoutGrid, Clock, User as UserIcon, Terminal, AlertTriangle, Send, Zap } from 'lucide-react';
import { db, auth } from '../lib/firebase';
import { collection, query, getDocs, doc, deleteDoc, updateDoc, collectionGroup, orderBy, setDoc, serverTimestamp } from 'firebase/firestore';
import { cn } from '../lib/utils';

interface AdminPanelProps {
  onClose: () => void;
  activeColor: string;
  activeText: string;
  activeBorder: string;
}

export default function AdminPanel({ onClose, activeColor, activeText, activeBorder }: AdminPanelProps) {
  const [users, setUsers] = useState<any[]>([]);
  const [globalTasks, setGlobalTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [view, setView] = useState<'users' | 'tasks' | 'terminal'>('users');
  const [command, setCommand] = useState('');
  const [logs, setLogs] = useState<string[]>(['[SYSTEM] NEURAL LINK ESTABLISHED', '[AUTH] ADMIN OVERRIDE ACTIVE']);

  useEffect(() => {
    fetchUsers();
    fetchGlobalTasks();
  }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, 'users'));
      const snapshot = await getDocs(q);
      const uList: any[] = [];
      snapshot.forEach(doc => uList.push({ id: doc.id, ...doc.data() }));
      setUsers(uList);
    } catch (err) {
      console.error("Admin fetch users failed:", err);
    }
    setLoading(false);
  };

  const fetchGlobalTasks = async () => {
    try {
      const q = query(collectionGroup(db, 'tasks'), orderBy('time', 'desc'));
      const snapshot = await getDocs(q);
      const tList: any[] = [];
      snapshot.forEach(doc => tList.push({ id: doc.id, ...doc.data(), parentPath: doc.ref.parent.path }));
      setGlobalTasks(tList);
    } catch (err) {
      console.error("Admin fetch tasks failed:", err);
    }
  };

  const executeCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;

    const cmd = command.toLowerCase().trim();
    const [action, ...args] = cmd.split(' ');
    
    setLogs(prev => [...prev, `> ${cmd}`]);

    try {
      if (action === 'broadcast') {
        const message = args.join(' ');
        await setDoc(doc(db, 'system', 'config'), {
          broadcast: message,
          updatedAt: serverTimestamp(),
          updatedBy: auth.currentUser?.uid
        }, { merge: true });
        setLogs(prev => [...prev, '[SYSTEM] GLOBAL BROADCAST ISSUED']);
      } 
      else if (action === 'purge_tasks') {
        const q = query(collectionGroup(db, 'tasks'));
        const snap = await getDocs(q);
        const batch: string[] = [];
        snap.forEach(d => batch.push(d.ref.path));
        setLogs(prev => [...prev, `[SYSTEM] PURGING ${batch.length} TASKS...`]);
        for (const path of batch) {
          await deleteDoc(doc(db, path));
        }
        await fetchGlobalTasks();
        setLogs(prev => [...prev, '[SYSTEM] GLOBAL PURGE COMPLETE']);
      }
      else if (action === 'clear_logs') {
        setLogs(['[SYSTEM] LOGS CLEARED']);
      }
      else if (action === 'help') {
        setLogs(prev => [...prev, 
          'AVAILABLE COMMANDS:',
          '- broadcast <msg>: Set global banner',
          '- purge_tasks: Remove all user tasks',
          '- clear_logs: Reset local console',
          '- refresh: Sync all nodes'
        ]);
      }
      else if (action === 'refresh') {
        await Promise.all([fetchUsers(), fetchGlobalTasks()]);
        setLogs(prev => [...prev, '[SYSTEM] NODES RE-SYNCHRONIZED']);
      }
      else {
        setLogs(prev => [...prev, `[ERROR] UNKNOWN COMMAND: ${action}`]);
      }
    } catch (err) {
      setLogs(prev => [...prev, `[ERROR] EXECUTION FAILED: ${err instanceof Error ? err.message : 'Unknown'}`]);
    }

    setCommand('');
  };

  const deleteUser = async (uid: string) => {
    if (uid === auth.currentUser?.uid) {
      alert("Cannot delete yourself.");
      return;
    }
    if (confirm("Permanently delete this user node?")) {
      try {
        await deleteDoc(doc(db, 'users', uid));
        setUsers(users.filter(u => u.uid !== uid));
      } catch (err) {
        alert("Delete failed.");
      }
    }
  };

  const toggleAdmin = async (user: any) => {
    if (user.uid === auth.currentUser?.uid) return;
    const newRole = user.role === 'admin' ? 'user' : 'admin';
    try {
      await updateDoc(doc(db, 'users', user.uid), { role: newRole });
      setUsers(users.map(u => u.uid === user.uid ? { ...u, role: newRole } : u));
    } catch (err) {
      alert("Role update failed.");
    }
  };

  const deleteGlobalTask = async (task: any) => {
    if (confirm("Delete this task from user stack?")) {
      try {
        await deleteDoc(doc(db, task.parentPath, task.id));
        setGlobalTasks(globalTasks.filter(t => t.id !== task.id));
      } catch (err) {
        alert("Delete failed.");
      }
    }
  };

  const filteredUsers = users.filter(u => 
    u.displayName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    u.email?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="flex flex-col h-full bg-black/90 rounded-3xl border border-white/10 backdrop-blur-3xl overflow-hidden z-[100]"
    >
      <div className="p-6 border-b border-white/10 flex justify-between items-center bg-white/5">
        <div className="flex items-center gap-3">
          <div className={cn("p-2 rounded-xl", activeColor)}>
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-sm uppercase tracking-[0.2em] font-black">Admin Protocol</h2>
            <p className="text-[10px] opacity-40 uppercase tracking-widest">Master Control Overide</p>
          </div>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
          <X className="w-5 h-5 opacity-40" />
        </button>
      </div>

      <div className="flex border-b border-white/5">
         <button 
           onClick={() => setView('users')}
           className={cn(
             "flex-1 py-4 text-[10px] uppercase font-black tracking-widest flex items-center justify-center gap-2 transition-all",
             view === 'users' ? cn("bg-white/5", activeText) : "opacity-30 hover:opacity-60"
           )}
         >
           <Users className="w-3 h-3" /> User Nodes
         </button>
         <button 
           onClick={() => setView('tasks')}
           className={cn(
             "flex-1 py-4 text-[10px] uppercase font-black tracking-widest flex items-center justify-center gap-2 transition-all",
             view === 'tasks' ? cn("bg-white/5", activeText) : "opacity-30 hover:opacity-60"
           )}
         >
           <LayoutGrid className="w-3 h-3" /> Global Sensor Grid
         </button>
         <button 
           onClick={() => setView('terminal')}
           className={cn(
             "flex-1 py-4 text-[10px] uppercase font-black tracking-widest flex items-center justify-center gap-2 transition-all",
             view === 'terminal' ? cn("bg-white/5", activeText) : "opacity-30 hover:opacity-60"
           )}
         >
           <Terminal className="w-3 h-3" /> Neural Override
         </button>
      </div>

      <div className="p-4 space-y-4 flex-1 overflow-hidden flex flex-col">
        {view === 'users' && (
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 opacity-30" />
            <input 
              type="text"
              placeholder="Scan Neural Signatures (Search Name/Email)..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-white/5 border border-white/5 rounded-2xl pl-12 pr-4 py-3 text-xs focus:outline-none focus:border-white/20 transition-all font-mono"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto pr-2 space-y-2 scrollbar-hide">
          {loading ? (
             <div className="flex flex-col items-center justify-center py-20 opacity-20">
                <Database className="w-12 h-12 animate-pulse mb-4" />
                <p className="text-[10px] uppercase font-black tracking-widest">Synchronizing Nodes...</p>
             </div>
          ) : (
            <>
              {view === 'users' ? (
                filteredUsers.length === 0 ? (
                  <div className="text-center py-20 opacity-20">
                     <Ban className="w-12 h-12 mx-auto mb-4" />
                     <p className="text-[10px] uppercase font-black tracking-widest">No Signatures Found</p>
                  </div>
                ) : (
                  filteredUsers.map(u => (
                    <div key={u.id} className="p-4 bg-white/5 border border-white/5 rounded-2xl flex items-center gap-4 group transition-all hover:bg-white/10">
                      <img src={u.photoURL || `https://ui-avatars.com/api/?name=${u.displayName}`} className="w-10 h-10 rounded-full border border-white/10" alt="" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-bold truncate">{u.displayName}</p>
                          {u.role === 'admin' && (
                            <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400 text-[8px] font-black uppercase tracking-tighter border border-cyan-500/30">Admin</span>
                          )}
                        </div>
                        <p className="text-[10px] opacity-40 truncate">{u.email}</p>
                      </div>
                      <div className="flex gap-2">
                         <button 
                          onClick={() => toggleAdmin(u)}
                          className={cn(
                            "p-2 rounded-xl transition-all active:scale-90",
                            u.role === 'admin' ? "bg-cyan-500/20 text-cyan-400" : "bg-white/5 text-white/40 hover:text-white"
                          )}
                          title={u.role === 'admin' ? "Revoke Admin" : "Grant Admin"}
                        >
                          <Settings2 className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => deleteUser(u.uid)}
                          className="p-2 rounded-xl bg-red-500/10 text-red-500/40 hover:text-red-500 transition-all active:scale-90"
                          title="Terminate Node"
                        >
                          <Trash className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                )
              ) : view === 'tasks' ? (
                globalTasks.length === 0 ? (
                  <div className="text-center py-20 opacity-20">
                     <Clock className="w-12 h-12 mx-auto mb-4" />
                     <p className="text-[10px] uppercase font-black tracking-widest">Global Stack Empty</p>
                  </div>
                ) : (
                  globalTasks.map(t => (
                    <div key={t.id} className="p-4 bg-white/5 border border-white/5 rounded-2xl flex items-center gap-4 hover:bg-white/10 transition-all group">
                       <div className={cn("p-2 rounded-xl bg-white/5 border border-white/10", activeText)}>
                          {t.type === 'SET_TIMER' ? <Clock className="w-4 h-4" /> : <LayoutGrid className="w-4 h-4" />}
                       </div>
                       <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-white/60">
                             {t.type.replace('_', ' ')}
                             <span className="opacity-30">•</span>
                             <span className="text-[9px] flex items-center gap-1 opacity-40"><UserIcon className="w-2 h-2" /> {t.userId?.substring(0, 8)}...</span>
                          </div>
                          <p className="text-xs truncate font-mono opacity-80 mt-1">{t.value}</p>
                       </div>
                       <button 
                         onClick={() => deleteGlobalTask(t)}
                         className="p-2 rounded-xl bg-red-500/10 text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                       >
                         <Trash2 className="w-4 h-4" />
                       </button>
                    </div>
                  ))
                )
              ) : (
                <div className="flex flex-col h-full bg-black/40 rounded-2xl border border-white/5 font-mono p-4 space-y-4">
                   <div className="flex-1 overflow-y-auto space-y-1 text-[10px]">
                      {logs.map((log, i) => (
                        <div key={i} className={cn(
                          log.startsWith('>') ? "text-white/40" : 
                          log.startsWith('[ERROR]') ? "text-red-400" : 
                          log.startsWith('[SYSTEM]') ? "text-cyan-400" : "text-white/80"
                        )}>
                          {log}
                        </div>
                      ))}
                   </div>
                   <form onSubmit={executeCommand} className="flex gap-2 border-t border-white/10 pt-4">
                      <div className="flex-1 relative">
                        <Terminal className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 opacity-30" />
                        <input 
                          type="text"
                          autoFocus
                          value={command}
                          onChange={(e) => setCommand(e.target.value)}
                          placeholder="ENTER NEURAL OVERRIDE COMMAND (HELP for list)..."
                          className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-3 py-2 text-[10px] uppercase font-mono tracking-widest focus:outline-none focus:border-cyan-500/50 transition-all"
                        />
                      </div>
                      <button 
                        type="submit"
                        className="p-2 bg-cyan-500/20 text-cyan-400 rounded-xl hover:bg-cyan-500/30 transition-all"
                      >
                        <Send className="w-3 h-3" />
                      </button>
                   </form>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="p-6 bg-white/5 border-t border-white/10 flex justify-between items-center">
        <div className="text-[10px] opacity-30 font-mono">
           {view === 'users' ? `NODES: ${users.length}` : `TOTAL_TASKS: ${globalTasks.length}`}
        </div>
        <button 
          onClick={() => { view === 'users' ? fetchUsers() : fetchGlobalTasks() }}
          className="px-4 py-2 rounded-xl bg-white/5 border border-white/5 text-[10px] font-black tracking-widest uppercase hover:bg-white/10 transition-all"
        >
          Refresh Sig
        </button>
      </div>
    </motion.div>
  );
}
