/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Volume2, VolumeX, Settings, MessageSquare, History, Globe, Battery, Wifi, Signal, Trash2, Phone, ArrowLeft, Check, Activity, Camera, X, LogIn, LogOut, ShieldAlert, Zap, Search } from 'lucide-react';
import { getAssistantResponse } from './services/geminiService';
import { cn } from './lib/utils';
import ReactMarkdown from 'react-markdown';
import AdminPanel from './components/AdminPanel';
import { auth, db } from './lib/firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User } from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot, updateDoc, collection, query, orderBy, limit, deleteDoc, serverTimestamp, getDocs, addDoc } from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(errInfo.error);
}

// Types for Speech Recognition
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: any) => void;
  onend: () => void;
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

// Levenshtein distance for fuzzy wake word detection
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function checkWakeWord(transcript: string, sensitivity: number): { detected: boolean; command: string } {
  const words = transcript.trim().split(/\s+/);
  const target = "aura";
  
  // Sensitivity mapping:
  const thresholds = {1: 0, 2: 1, 3: 1, 4: 2, 5: 2};
  const threshold = thresholds[sensitivity as keyof typeof thresholds] || 1;

  let detectedIndex = -1;
  
  for (let i = 0; i < words.length; i++) {
      const word = words[i].toLowerCase().replace(/[^a-z]/g, '');
      if (word === target) {
          detectedIndex = i;
          break;
      }
      if (threshold > 0 && word.length >= 2) { // Need at least 2 chars to compare distance meaningfully
          if (levenshtein(word, target) <= threshold) {
              detectedIndex = i;
              break;
          }
      }
  }
  
  if (detectedIndex === -1 && sensitivity >= 4) {
      if (transcript.toLowerCase().includes("aura")) {
          const split = transcript.toLowerCase().split("aura");
          return { detected: true, command: split.slice(1).join("aura").trim() || "" };
      }
  }

  if (detectedIndex !== -1) {
      const commandWords = words.slice(detectedIndex + 1);
      return { detected: true, command: commandWords.join(" ") };
  }

  return { detected: false, command: "" };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionGreeted, setSessionGreeted] = useState(false);
  const [completingTasks, setCompletingTasks] = useState<Set<string>>(new Set());
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [history, setHistory] = useState<{ role: 'user' | 'model', text: string, image?: string }[]>([]);
  const [tasks, setTasks] = useState<{ id: string; type: string; value: string; time: number; remaining?: number; dueAt?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isUserTyping, setIsUserTyping] = useState(false);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const clearError = () => setError(null);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const [deviceStats, setDeviceStats] = useState({ battery: 100, online: navigator.onLine, location: 'Scanning...', networkType: 'WiFi', networkSpeed: 'Fast' });
  const [activeTab, setActiveTab] = useState<'chat' | 'tasks' | 'settings' | 'admin'>('chat');
  // Auth & Data Sync
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      
      // If we determined auth state (logged in or not), we can stop blocking the UI
      // Background sync will continue for profile data
      if (u) {
        // Sync User Data in background
        const userRef = doc(db, 'users', u.uid);
        getDoc(userRef).then(async (userSnap) => {
          if (!userSnap.exists()) {
            const newUser = {
              uid: u.uid,
              email: u.email,
              displayName: u.displayName,
              photoURL: u.photoURL,
              role: u.email === 'sajidmahamud043@gmail.com' ? 'admin' : 'user',
              settings: settingsRef.current,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            };
            await setDoc(userRef, newUser).catch(e => handleFirestoreError(e, OperationType.CREATE, `users/${u.uid}`));
            setUserData(newUser);
            setIsAdmin(newUser.role === 'admin');
          } else {
            const data = userSnap.data();
            setUserData(data);
            setIsAdmin(data.role === 'admin');
            if (data.settings) {
              setSettings(data.settings);
            }
          }
          setLoading(false);
        }).catch(() => setLoading(false));

        // Sync Tasks (Stream)
        const tasksRef = collection(db, 'users', u.uid, 'tasks');
        const qTasks = query(tasksRef, orderBy('time', 'desc'), limit(50));
        const unsubTasks = onSnapshot(qTasks, (snapshot) => {
          const t: any[] = [];
          snapshot.forEach(doc => t.push({ id: doc.id, ...doc.data() }));
          setTasks(t);
        }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${u.uid}/tasks`));

        // Sync Neural Memories (Messages History)
        const messagesRef = collection(db, 'users', u.uid, 'messages');
        const qMessages = query(messagesRef, orderBy('timestamp', 'asc'), limit(50));
        const unsubMessages = onSnapshot(qMessages, (snapshot) => {
          const m: any[] = [];
          snapshot.forEach(doc => {
            const data = doc.data();
            m.push({ role: data.role, text: data.text });
          });
          if (m.length > 0) {
            setHistory(m);
          }
        }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${u.uid}/messages`));

        return () => {
          unsubTasks();
          unsubMessages();
        };
      } else {
        setUserData(null);
        setIsAdmin(false);
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (user && userData && !sessionGreeted) {
      const userName = userData.displayName ? userData.displayName.split(' ')[0] : (user.displayName ? user.displayName.split(' ')[0] : 'User');
      const msg = `Hello ${userName} how are you ? Im always here to help you !!`;
      
      setHistory(prev => {
        if (prev.length > 0 && prev[prev.length-1].text === msg) return prev;
        return [...prev, { role: 'model', text: msg }];
      });
      speak(msg);
      setSessionGreeted(true);
    }
  }, [user, userData, sessionGreeted]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      setError("Login failed. Please check your connection.");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setHistory([]);
      setTasks([]);
      setActiveTab('chat');
    } catch (err) {
      setError("Logout failed.");
    }
  };
  const [wakeDetected, setWakeDetected] = useState(false);
  const [systemConfig, setSystemConfig] = useState<any>(null);
  const wakeTriggeredRef = useRef(false);

  // Sync System Config
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'system', 'config'), (snap) => {
      if (snap.exists()) setSystemConfig(snap.data());
    });
    return () => unsub();
  }, []);
  
  const [isCameraActive, setIsCameraActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  const playWakeSound = useCallback(() => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(600, audioCtx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(900, audioCtx.currentTime + 0.1);
      
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
      gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.15);
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
      console.warn("AudioContext not supported", e);
    }
  }, []);
  
  const playCompleteSound = useCallback(() => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(800, audioCtx.currentTime); // High pitch for completion
      oscillator.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1);
      
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.05);
      gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.15);
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.15);
      
      if ('vibrate' in navigator && settingsRef.current.hapticFeedback) {
        navigator.vibrate(50);
      }
    } catch (e) {
      console.warn("AudioContext not supported", e);
    }
  }, []);

  // Action execution simulator state
  const [executingActions, setExecutingActions] = useState<any[]>([]);
  const [currentExecIndex, setCurrentExecIndex] = useState(-1);

  useEffect(() => {
    if (currentExecIndex >= 0 && currentExecIndex < executingActions.length) {
      const action = executingActions[currentExecIndex];
      let delay = 1500; // default delay between simulated actions

      if (action.action === 'WAIT') {
        delay = (action.seconds || 2) * 1000;
      }

      // Action simulator for web environment instantly triggering app links if recognized
      if (action.action === 'OPEN_APP') {
        const app = (action.app_name || '').toLowerCase();
        if (app.includes('youtube')) window.open('https://youtube.com', '_blank');
        else if (app.includes('facebook')) window.open('https://facebook.com', '_blank');
        else if (app.includes('whatsapp')) window.open('https://web.whatsapp.com', '_blank');
        else if (app.includes('bkash')) console.log("Simulating opening bKash...");
      }

      const timer = setTimeout(() => {
        setCurrentExecIndex(currentExecIndex + 1);
      }, delay);
      return () => clearTimeout(timer);
    } else if (currentExecIndex >= executingActions.length && executingActions.length > 0) {
      const timer = setTimeout(() => {
        setExecutingActions([]);
        setCurrentExecIndex(-1);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [currentExecIndex, executingActions]);

  const [showInput, setShowInput] = useState(false);
  const [inputText, setInputText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Settings with Persistence
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem('aura_settings');
    const parsed = saved ? JSON.parse(saved) : {};
    return {
      userName: 'Sajid',
      profilePic: '',
      voiceSpeed: 1.05,
      voicePitch: 1.1,
      theme: 'cyan',
      accentColor: '#06b6d4',
      autoListen: false,
      autoListenSensitivity: 3, // 1 to 5
      hapticFeedback: true,
      ...parsed
    };
  });

  const settingsRef = useRef(settings);
  const isSpeakingRef = useRef(isSpeaking);

  useEffect(() => {
    settingsRef.current = settings;
    localStorage.setItem('aura_settings', JSON.stringify(settings));
    
    // Sync settings to Firestore if logged in
    if (user) {
      updateDoc(doc(db, 'users', user.uid), { 
        settings: settings,
        updatedAt: serverTimestamp()
      }).catch(e => console.warn("Settings sync failed:", e));
    }
  }, [settings, user]);

  useEffect(() => {
    isSpeakingRef.current = isSpeaking;
  }, [isSpeaking]);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const synthesisRef = useRef<SpeechSynthesisUtterance | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleTextInput = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) {
      handleUserCommand(inputText);
      setInputText('');
      setShowInput(false);
    }
  };

  useEffect(() => {
    // Online Status
    const handleOnline = () => setDeviceStats(prev => ({ ...prev, online: true }));
    const handleOffline = () => setDeviceStats(prev => ({ ...prev, online: false }));
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Network Information
    const updateNetworkInfo = () => {
      const connection = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
      if (connection) {
        setDeviceStats(prev => ({
          ...prev,
          networkType: connection.effectiveType ? connection.effectiveType.toUpperCase() : 'Wi-Fi',
          networkSpeed: connection.downlink ? `${connection.downlink}Mbps` : 'Fast'
        }));
      }
    };
    
    updateNetworkInfo();
    const connection = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
    if (connection) {
      connection.addEventListener('change', updateNetworkInfo);
    }

    // Battery & Status Simulation
    if ('getBattery' in navigator) {
      (navigator as any).getBattery().then((batt: any) => {
        setDeviceStats(prev => ({ ...prev, battery: Math.floor(batt.level * 100) }));
        batt.addEventListener('levelchange', () => {
          setDeviceStats(prev => ({ ...prev, battery: Math.floor(batt.level * 100) }));
        });
      });
    }

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition((pos) => {
        setDeviceStats(prev => ({ ...prev, location: `Lat: ${pos.coords.latitude.toFixed(2)}` }));
      }, () => {
        setDeviceStats(prev => ({ ...prev, location: 'Access Denied' }));
      });
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true; // Make it more powerful by staying active
      recognition.interimResults = true;
      recognition.lang = 'bn-BD'; // Recognition should prioritize native Bengali engine for better accuracy with accents

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const current = event.results[event.resultIndex][0].transcript;
        setTranscript(current);
        
        if (settingsRef.current.autoListen && !wakeTriggeredRef.current) {
          const interimCheck = checkWakeWord(current, settingsRef.current.autoListenSensitivity || 3);
          if (interimCheck.detected) {
            wakeTriggeredRef.current = true;
            setWakeDetected(true);
            playWakeSound();
            setTimeout(() => setWakeDetected(false), 2000);
          }
        }
        
        // Use a timeout to detect when user stops speaking for "speed"
        if (event.results[event.resultIndex].isFinal) {
          let commandToProcess = current;

          if (settingsRef.current.autoListen) {
            const wakeCheck = checkWakeWord(current, settingsRef.current.autoListenSensitivity || 3);
            if (!wakeCheck.detected) {
              // Ignore if wake word not found, restart
              wakeTriggeredRef.current = false;
              recognition.stop();
              return;
            }
            commandToProcess = wakeCheck.command;
            if (!commandToProcess) {
              speak("Yes, how can I help?");
              wakeTriggeredRef.current = false;
              recognition.stop();
              return;
            }
          }

          wakeTriggeredRef.current = false;
          handleUserCommand(commandToProcess);
          recognition.stop();
        }
      };

      recognition.onerror = (event: any) => {
        if (['no-speech', 'aborted', 'audio-capture'].includes(event.error)) {
          console.warn('Speech engine warning:', event.error);
          setIsListening(false);
          return;
        }
        console.error('Recognition error:', event.error);
        if (!settingsRef.current.autoListen) {
          setError(`System Alert: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
        if (settingsRef.current.autoListen && !isSpeakingRef.current) {
          try {
            recognition.start();
          } catch (e) {
            console.error("Auto-listen restart failed:", e);
          }
        }
      };

      recognitionRef.current = recognition;

      // Start auto listening if enabled
      if (settings.autoListen) {
        try { recognition.start(); } catch(e) {}
      }
    } else {
      setError('Speech Recognition not supported in this browser.');
    }
  }, []);

  // Timer Countdown Logic
  useEffect(() => {
    const timer = setInterval(() => {
      setTasks(prev => prev.map(task => {
        if (task.type === 'SET_TIMER' && task.remaining !== undefined && task.remaining > 0) {
          const newRemaining = task.remaining - 1;
          if (newRemaining === 0) {
            // Timer Finished
            speak(`${task.value} er jonno set kora apnar timer-ti shesh hoyeche.`);
          }
          return { ...task, remaining: newRemaining };
        }
        return task;
      }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const startCamera = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("Your browser does not support camera access.");
      return;
    }

    try {
      // Try with preferred constraints first
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { facingMode: 'user' } 
        });
      } catch (e) {
        // Fallback to basic video if facingMode fails
        console.warn("Retrying camera with basic constraints...");
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }

      streamRef.current = stream;
      setIsCameraActive(true);
      
      // Delay assignment slightly to ensure video element is mounted in the DOM
      setTimeout(() => {
        if (videoRef.current && streamRef.current) {
          videoRef.current.srcObject = streamRef.current;
        }
      }, 100);

    } catch (err: any) {
      console.error("Camera access denied or unavailable", err);
      let msg = "Unable to access the camera.";
      if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError' || err.message?.includes('found')) {
        msg = "No camera device detected. Please connect a camera and try again.";
      } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = "Camera permission was denied. Please allow access in your browser settings.";
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        msg = "Camera is already in use by another application.";
      }
      setError(msg);
      setIsCameraActive(false);
    }
  };

  useEffect(() => {
    if (isCameraActive && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
    // Cleanup if stream becomes null or component updates
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [isCameraActive]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  }, []);

  const capturePhoto = () => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        setSettings({ ...settings, profilePic: dataUrl });
        stopCamera();
      }
    }
  };

  useEffect(() => {
    if (activeTab !== 'settings' && isCameraActive) {
      stopCamera();
    }
  }, [activeTab, isCameraActive, stopCamera]);

  const handleUserCommand = async (command: string, imageBase64?: string) => {
    if (!command.trim() && !imageBase64) return;
    if (!user) return;
    
    setIsProcessing(true);
    const messagesRef = collection(db, 'users', user.uid, 'messages');
    
    // Handle Voice Settings Commands
    const lowerCommand = command.toLowerCase();
    if (lowerCommand.includes('set voice speed to') || lowerCommand.includes('change theme to') || lowerCommand.includes('increase voice pitch') || lowerCommand.includes('decrease voice pitch')) {
      const newSettings = { ...settings };
      let changed = false;

      if (lowerCommand.includes('voice speed')) {
        const match = lowerCommand.match(/(\d+(\.\d+)?)/);
        if (match) {
          newSettings.voiceSpeed = parseFloat(match[0]);
          changed = true;
        }
      } else if (lowerCommand.includes('voice pitch')) {
        if (lowerCommand.includes('increase')) newSettings.voicePitch += 0.1;
        else if (lowerCommand.includes('decrease')) newSettings.voicePitch -= 0.1;
        changed = true;
      } else if (lowerCommand.includes('theme to')) {
        const themes = ['cyan', 'crimson', 'emerald', 'sunset', 'ocean', 'minimalist'];
        const targetTheme = themes.find(t => lowerCommand.includes(t));
        if (targetTheme) {
          newSettings.theme = targetTheme;
          // Set matching accent color
          const accents: Record<string, string> = { cyan: '#06b6d4', crimson: '#ef4444', emerald: '#10b981', sunset: '#f59e0b', ocean: '#3b82f6', minimalist: '#27272a' };
          newSettings.accentColor = accents[targetTheme];
          changed = true;
        }
      }

      if (changed) {
        setSettings(newSettings);
        const fbMsg = "Neural settings recalibrated.";
        setHistory(prev => [...prev, { role: 'model', text: fbMsg }]);
        speak(fbMsg);
        setIsProcessing(false);
        return;
      }
    }

    // AI Avatar Generation Logic
    if (lowerCommand.includes('generate') && (lowerCommand.includes('avatar') || lowerCommand.includes('profile picture'))) {
      try {
        const prompt = `A futuristic neural-link avatar icon, high-tech, cyberpunk aesthetic, matching the color palette: ${settings.theme === 'cyan' ? 'cyan and blue' : settings.theme === 'crimson' ? 'red and dark' : 'vibrant colors'}. minimalist digital art.`;
        const res = await getAssistantResponse(`[GENERATE_IMAGE: ${prompt}]`, [], undefined);
        const imageUrl = res.match(/https:\/\/.*?\.(png|jpg|jpeg|webp)/)?.[0];
        
        if (imageUrl) {
          setUserData({ ...userData, photoURL: imageUrl });
          if (user) {
            updateDoc(doc(db, 'users', user.uid), { photoURL: imageUrl })
              .catch(e => handleFirestoreError(e, OperationType.UPDATE, `users/${user.uid}`));
          }
          const fbMsg = "Neural representation synthesized.";
          setHistory(prev => [...prev, { role: 'model', text: fbMsg }]);
          speak(fbMsg);
          setIsProcessing(false);
          return;
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, 'image-generation');
      }
    }

    // Advanced Admin Commands
    if (isAdmin) {
      if (lowerCommand.includes('list users with role')) {
        const role = lowerCommand.includes('admin') ? 'admin' : 'user';
        const usersSnap = await getDocs(collection(db, 'users'))
          .catch(e => handleFirestoreError(e, OperationType.LIST, 'users'));
        if (usersSnap) {
          const admins = usersSnap.docs
            .filter(d => d.data().role === role)
            .map(d => d.data().email || d.id);
          const fbMsg = `NODE CLUSTER ${role.toUpperCase()}S: ${admins.join(', ')}`;
          setHistory(prev => [...prev, { role: 'model', text: fbMsg }]);
          speak(fbMsg);
          setIsProcessing(false);
          return;
        }
      } else if (lowerCommand.includes('get user tasks')) {
        const userId = command.split(' ').pop();
        if (userId) {
          const tasksSnap = await getDocs(collection(db, 'users', userId, 'tasks'))
            .catch(e => handleFirestoreError(e, OperationType.LIST, `users/${userId}/tasks`));
          if (tasksSnap) {
            const userTasks = tasksSnap.docs.map(d => d.data().value);
            const fbMsg = tasksSnap.empty ? "No active uplinks for this node." : `NODE ${userId} UPLINKS: ${userTasks.join(' | ')}`;
            setHistory(prev => [...prev, { role: 'model', text: fbMsg }]);
            speak(fbMsg);
            setIsProcessing(false);
            return;
          }
        }
      } else if (lowerCommand.includes('delete user')) {
        const userId = command.split(' ').pop();
        if (userId && window.confirm(`Initiate purging of node ${userId}?`)) {
          await deleteDoc(doc(db, 'users', userId))
            .catch(e => handleFirestoreError(e, OperationType.DELETE, `users/${userId}`));
          const fbMsg = `Node ${userId} purged from nexus.`;
          setHistory(prev => [...prev, { role: 'model', text: fbMsg }]);
          speak(fbMsg);
          setIsProcessing(false);
          return;
        }
      }
    }

    // Save User Query
    await addDoc(messagesRef, {
      role: 'user',
      text: command || '[Image Uploaded]',
      image: imageBase64 || null,
      timestamp: serverTimestamp()
    }).catch(e => handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}/messages`));
    
    try {
      const geminiHistory = history.map(h => {
        const parts: any[] = [{ text: h.text }];
        if (h.image) {
          const mimeType = h.image.substring(h.image.indexOf(":") + 1, h.image.indexOf(";"));
          const base64Data = h.image.substring(h.image.indexOf(",") + 1);
          parts.push({
            inlineData: {
              mimeType,
              data: base64Data
            }
          });
        }
        return { role: h.role, parts };
      });
      const response = await getAssistantResponse(command || 'Take a look at this image.', geminiHistory, imageBase64)
        .catch(err => {
          handleFirestoreError(err, OperationType.GET, 'gemini-service');
          throw err;
        });
      
      // Save AI Response
      let cleanResponse = response.replace(/\[ACTION:.*?\]/g, '').trim();
      await addDoc(messagesRef, {
        role: 'model',
        text: cleanResponse,
        timestamp: serverTimestamp()
      }).catch(e => handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}/messages`));

      try {
        let jsonStr = '';
        let parsed = null;

        const jsonMatch = response.match(/```json([\s\S]*?)```/);
        const rawArrayMatch = response.match(/\[\s*\{\s*"action"[\s\S]*\}\s*\]/);

        if (jsonMatch) {
          jsonStr = jsonMatch[1].trim();
          parsed = JSON.parse(jsonStr);
          cleanResponse = response.replace(/```json([\s\S]*?)```/, '').trim();
        } else if (response.trim().startsWith('[') && response.trim().endsWith(']')) {
          jsonStr = response.trim();
          parsed = JSON.parse(jsonStr);
          cleanResponse = "Action sequence initiated.";
        } else if (rawArrayMatch) {
          jsonStr = rawArrayMatch[0].trim();
          parsed = JSON.parse(jsonStr);
          cleanResponse = response.replace(rawArrayMatch[0], '').trim();
        }

        if (parsed) {
          const actions = Array.isArray(parsed) ? parsed : [parsed];
          
          // Start live execution sequence
          setExecutingActions(actions);
          setCurrentExecIndex(0);

          actions.forEach(async (action) => {
            const taskId = Math.random().toString(36).substr(2, 9);
            const newTask = {
              id: taskId,
              userId: user?.uid,
              type: action.action,
              value: action.app_name || action.element || action.text || action.direction || action.target || (action.seconds ? `${action.seconds}s` : ''),
              time: Date.now(),
              remaining: undefined,
              createdAt: serverTimestamp()
            };
            
            if (user) {
              await setDoc(doc(db, 'users', user.uid, 'tasks', taskId), newTask).catch(e => handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}/tasks/${taskId}`));
            }

            if (action.action === 'OPEN_APP') {
              console.log("Opening app:", action.app_name || action.target);
            } else if (action.action === 'CALL') {
              window.location.href = `tel:${action.target}`;
            } else if (action.action === 'SEND_MESSAGE') {
              window.location.href = `sms:?body=${encodeURIComponent(action.text || '')}`;
            }
          });
        }
      } catch (e) {
        console.warn("JSON parsing failed, falling back", e);
      }
      
      // If no natural text was left after removing JSON, provide a default friendly message
      if (!cleanResponse) {
        cleanResponse = "Action executed.";
      }

      const actionMatch = response.match(/\[ACTION:(.*?)\|(.*?)\]/);
      if (actionMatch) {
        const [, type, value] = actionMatch;
        
        let remaining: number | undefined;
        if (type === 'SET_TIMER') {
          const minutesMatch = value.match(/(\d+)\s*(minute|মিনিট)/);
          const secondsMatch = value.match(/(\d+)\s*(second|সেকেন্ড)/);
          remaining = (parseInt(minutesMatch?.[1] || '0') * 60) + parseInt(secondsMatch?.[1] || '0');
          if (remaining === 0) remaining = 60;
        }

        const taskId = Math.random().toString(36).substr(2, 9);
        const newTask = {
          id: taskId,
          userId: user?.uid,
          type: type,
          value: value,
          time: Date.now(),
          remaining: remaining,
          createdAt: serverTimestamp()
        };
        
        if (user) {
          setDoc(doc(db, 'users', user.uid, 'tasks', taskId), newTask).catch(e => handleFirestoreError(e, OperationType.CREATE, `users/${user.uid}/tasks/${taskId}`));
        }

        if (type === 'SEARCH') {
          window.open(`https://www.google.com/search?q=${encodeURIComponent(value)}`, '_blank');
        } else if (type === 'CALL') {
          window.location.href = `tel:${value}`;
        } else if (type === 'SEND_MESSAGE') {
          window.location.href = `sms:?body=${encodeURIComponent(value)}`;
        }
      }

      setHistory(prev => [...prev, { role: 'model', text: cleanResponse || 'Action executed.' }]);
      setIsProcessing(false);
      
      if (cleanResponse) {
        speak(cleanResponse);
      }
    } catch (err: any) {
      setError(err?.message || 'Connection interrupted. Please check your network.');
      setIsProcessing(false);
      console.error(err);
    }
  };

  const speak = (text: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      
      // Pronunciation dictionary for common Bengali-Latin (Banglish) words
      const phoneticsMap: Record<string, string> = {
        'ami': 'aamee',
        'kivabe': 'keebhaabe',
        'kemon': 'kæmon',
        'acho': 'aacho',
        'bhalo': 'bhaalo',
        'valo': 'bhaalo',
        'tomake': 'tomaake',
        'sahajjo': 'shaahajjo',
        'korte': 'kortê',
        'pari': 'paari',
        'dhonnobad': 'dhonnobaad',
        'aura': 'awwra'
      };
      
      let enhancedText = text;
      Object.entries(phoneticsMap).forEach(([word, replacement]) => {
        const regex = new RegExp(`\\b${word}\\b`, 'gi');
        enhancedText = enhancedText.replace(regex, match => {
          if (match === match.toUpperCase()) return replacement.toUpperCase();
          if (match[0] === match[0].toUpperCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
          return replacement;
        });
      });

      const utterance = new SpeechSynthesisUtterance(enhancedText);
      const voices = window.speechSynthesis.getVoices();
      
      // Prioritize hi-IN and en-IN for better subcontinental Romanized pronunciation
      const preferredVoice = voices.find(v => v.lang === 'hi-IN' && v.name.includes('Google')) ||
                            voices.find(v => v.lang.includes('en-IN') && v.name.includes('Google')) || 
                            voices.find(v => v.lang.includes('hi-IN')) ||
                            voices.find(v => v.lang.includes('en-IN')) ||
                            voices.find(v => v.lang === 'en-US' && v.name.includes('Google')) ||
                            voices.find(v => v.lang.includes('en-GB') || v.lang === 'en-US') ||
                            voices[0];
      
      if (preferredVoice) {
        utterance.voice = preferredVoice;
        utterance.lang = preferredVoice.lang;
      } else {
        utterance.lang = 'en-US';
      } 
      utterance.rate = settingsRef.current.voiceSpeed;
      utterance.pitch = settingsRef.current.voicePitch;
      
      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => {
        setIsSpeaking(false);
        if (settingsRef.current.autoListen) {
          try { recognitionRef.current?.start(); } catch (e) {}
        }
      };
      utterance.onerror = () => {
        setIsSpeaking(false);
        if (settingsRef.current.autoListen) {
          try { recognitionRef.current?.start(); } catch (e) {}
        }
      };
      
      synthesisRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    }
  };

  const toggleListening = () => {
    if ('vibrate' in navigator && settingsRef.current.hapticFeedback) {
      navigator.vibrate(40);
    }
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      setError(null);
      setTranscript('');
      speak(`Hi ${settings.userName}! Ami tomake kivabe help korte pari?`);
      setTimeout(() => {
        try {
          if (recognitionRef.current) recognitionRef.current.start();
        } catch (err) {
          console.error("Recognition start failed:", err);
          setIsListening(false);
        }
      }, 700);
    }
  };

  const stopSpeaking = () => {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  };

  const activeColor = {
    cyan: 'bg-cyan-500',
    purple: 'bg-purple-500',
    green: 'bg-emerald-500',
    forest: 'bg-emerald-700',
    ocean: 'bg-blue-500',
    minimalist: 'bg-zinc-300'
  }[settings.theme as 'cyan' | 'purple' | 'green' | 'forest' | 'ocean' | 'minimalist'];

  const activeText = {
    cyan: 'text-cyan-400',
    purple: 'text-purple-400',
    green: 'text-emerald-400',
    forest: 'text-emerald-300',
    ocean: 'text-blue-400',
    minimalist: 'text-zinc-200'
  }[settings.theme as 'cyan' | 'purple' | 'green' | 'forest' | 'ocean' | 'minimalist'];

  const activeBorder = {
    cyan: 'border-cyan-500/30',
    purple: 'border-purple-500/30',
    green: 'border-emerald-500/30',
    forest: 'border-emerald-700/30',
    ocean: 'border-blue-500/30',
    minimalist: 'border-zinc-300/30'
  }[settings.theme as 'cyan' | 'purple' | 'green' | 'forest' | 'ocean' | 'minimalist'];

  const activeShadow = {
    cyan: 'shadow-cyan-500/20',
    purple: 'shadow-purple-500/20',
    green: 'shadow-emerald-500/20',
    forest: 'shadow-emerald-700/20',
    ocean: 'shadow-blue-500/20',
    minimalist: 'shadow-zinc-300/20'
  }[settings.theme as 'cyan' | 'purple' | 'green' | 'forest' | 'ocean' | 'minimalist'];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, transcript]);

  return (
    <div className={cn(
      "h-[100dvh] w-full overflow-hidden text-white font-sans selection:bg-white/20 transition-colors duration-700",
      settings.theme === 'cyan' && "bg-[#050b10] bg-[radial-gradient(circle_at_top_right,_#083344_0%,_transparent_50%)]",
      settings.theme === 'purple' && "bg-[#0a0510] bg-[radial-gradient(circle_at_top_right,_#4c1d95_0%,_transparent_50%)]",
      settings.theme === 'green' && "bg-[#05100a] bg-[radial-gradient(circle_at_top_right,_#064e3b_0%,_transparent_50%)]",
      settings.theme === 'forest' && "bg-[#021207] bg-[radial-gradient(ellipse_at_top_right,_#065f46_0%,_transparent_50%)]",
      settings.theme === 'ocean' && "bg-[#040b16] bg-[radial-gradient(circle_at_bottom_left,_#1e3a8a_0%,_transparent_50%)]",
      settings.theme === 'minimalist' && "bg-[#09090b] bg-[radial-gradient(circle_at_center,_#27272a_0%,_transparent_100%)]"
    )}>
      {/* Refined Error Notification */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="fixed top-24 inset-x-6 z-[200] max-w-md mx-auto"
          >
            <div className="bg-red-500/20 border border-red-500/30 backdrop-blur-3xl rounded-2xl p-4 flex items-start gap-4 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
               <div className="p-2 bg-red-500/20 rounded-xl text-red-500">
                  <ShieldAlert className="w-5 h-5" />
               </div>
               <div className="flex-1 min-w-0 pt-1">
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-red-500 mb-1">Nexus System Error</h3>
                  <p className="text-[11px] text-white/80 font-mono leading-relaxed">{error}</p>
               </div>
               <button 
                onClick={clearError}
                className="p-1 hover:bg-white/10 rounded-lg transition-colors"
               >
                  <X className="w-4 h-4 opacity-40 hover:opacity-100" />
               </button>
            </div>
            <div className="h-1 bg-red-500/30 mt-1 rounded-full overflow-hidden">
               <motion.div 
                 initial={{ width: "100%" }}
                 animate={{ width: "0%" }}
                 transition={{ duration: 5, ease: "linear" }}
                 onAnimationComplete={clearError}
                 className="h-full bg-red-500" 
               />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {!user && !loading ? (
          <motion.div 
            key="login"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="fixed inset-0 z-[150] flex flex-col items-center justify-center p-6 text-center"
          >
            <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-40">
              <div className="absolute -top-[20%] -left-[20%] w-[60%] h-[60%] rounded-full blur-[150px] bg-cyan-500/20" />
              <div className="absolute -bottom-[20%] -right-[20%] w-[60%] h-[60%] rounded-full blur-[150px] bg-purple-500/20" />
            </div>
            
            <div className="relative mb-12">
               <div className="w-24 h-24 rounded-full border-2 border-white/10 flex items-center justify-center p-4 bg-white/5 backdrop-blur-3xl shadow-[0_0_50px_rgba(255,255,255,0.05)]">
                  <Globe className="w-full h-full text-cyan-400 animate-pulse" />
               </div>
               <div className="absolute -inset-4 border border-white/5 rounded-full animate-[spin_10s_linear_infinite]" />
            </div>

            <h1 className="text-4xl font-light tracking-tighter mb-4">
              Aura <span className="opacity-20 font-black italic">PRO</span>
            </h1>
            <p className="text-[10px] uppercase tracking-[0.4em] font-black opacity-30 mb-12">Universal Intelligence Interface</p>
            
            <button 
              onClick={handleLogin}
              className="group relative px-8 py-4 bg-white text-black rounded-2xl font-bold flex items-center gap-3 transition-all active:scale-95 hover:shadow-[0_0_30px_rgba(255,255,255,0.3)]"
            >
              <LogIn className="w-5 h-5" />
              Sign in with Neural ID
              <div className="absolute inset-0 rounded-2xl border border-white group-hover:scale-110 opacity-0 group-hover:opacity-100 transition-all" />
            </button>
            <p className="mt-8 text-[10px] opacity-20 uppercase tracking-widest font-bold">Encrypted via Nexus Protocol</p>
          </motion.div>
        ) : loading ? (
          <motion.div 
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex flex-col items-center justify-center space-y-4"
          >
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
            <div className="relative flex flex-col items-center space-y-4">
              <div className={cn("w-12 h-12 rounded-full border-4 border-white/10 border-t-white animate-spin", activeBorder)} />
              <div className="flex flex-col items-center gap-1">
                <p className="text-[9px] uppercase tracking-[0.5em] font-black animate-pulse text-white/60">Establishing Neural Link</p>
                <p className="text-[8px] font-mono opacity-30 uppercase">Nexus Protocol Handshake...</p>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none opacity-20">
        <div className={cn("absolute -top-[10%] -left-[10%] w-[50%] h-[50%] rounded-full blur-[120px]", activeColor)} />
        <div className="absolute top-[20%] right-[-5%] w-[30%] h-[30%] rounded-full bg-white/5 blur-[80px]" />
      </div>

      {/* Status Bar */}
      <div className="fixed top-0 w-full px-4 sm:px-6 py-2 flex justify-between items-center text-[10px] sm:text-xs font-mono opacity-50 z-[60]">
        <div className="flex gap-2 items-center">
          <span>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <div className="flex items-center gap-1 opacity-70">
            <Signal className="w-3 h-3" />
            <span>{deviceStats.networkType}</span>
            <span>({deviceStats.networkSpeed})</span>
          </div>
          <Wifi className={cn("w-3 h-3 transition-colors duration-500", !deviceStats.online ? "text-red-500 animate-pulse" : "text-green-400")} />
        </div>
        <div className="flex gap-2 items-center">
          <span className="opacity-50">{deviceStats.location}</span>
          <motion.div
            animate={{ opacity: deviceStats.battery <= 20 ? [0.4, 1, 0.4] : 1 }}
            transition={{ repeat: Infinity, duration: 1.5 }}
          >
            <Battery className={cn("w-3 h-3", deviceStats.battery <= 20 && "text-red-500")} />
          </motion.div>
          <span>{deviceStats.battery}%</span>
        </div>
      </div>

      {/* Action Execution Overlay */}
      <AnimatePresence>
        {currentExecIndex >= 0 && executingActions.length > 0 && currentExecIndex < executingActions.length && (
          <motion.div 
            initial={{ opacity: 0, y: -50, scale: 0.9 }} 
            animate={{ opacity: 1, y: 0, scale: 1 }} 
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="fixed top-20 left-0 w-full px-6 z-[100] pointer-events-none flex justify-center"
          >
            <div className="bg-black/90 backdrop-blur-3xl border border-white/20 p-6 rounded-3xl flex flex-col items-center min-w-[250px] shadow-[0_0_50px_rgba(255,255,255,0.1)]">
              <div className="w-12 h-12 rounded-full border-2 border-white/20 border-t-white flex items-center justify-center mb-4 animate-spin">
                 <Settings className={cn("w-5 h-5", activeText)} />
              </div>
              <h3 className="text-[10px] uppercase font-black tracking-[0.3em] opacity-50 mb-2">Accessibility Node</h3>
              <p className="text-lg font-bold text-center tracking-tight">
                 {executingActions[currentExecIndex].action === 'OPEN_APP' && `Opening ${executingActions[currentExecIndex].app_name || 'App'}...`}
                 {executingActions[currentExecIndex].action === 'CLICK' && `Tapping "${executingActions[currentExecIndex].element || 'Button'}"`}
                 {executingActions[currentExecIndex].action === 'TYPE' && `Typing text...`}
                 {executingActions[currentExecIndex].action === 'SCROLL' && `Scrolling ${executingActions[currentExecIndex].direction || 'down'}...`}
                 {executingActions[currentExecIndex].action === 'WAIT' && `Waiting ${executingActions[currentExecIndex].seconds || 2}s...`}
              </p>
              <div className="mt-4 flex gap-1">
                {executingActions.map((_, i) => (
                  <div key={i} className={cn("h-1 rounded-full transition-all duration-300", i === currentExecIndex ? cn("w-4", activeColor) : "w-1 bg-white/20")} />
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Container */}
      <main className="relative max-w-lg mx-auto px-4 sm:px-6 pt-12 sm:pt-16 pb-40 sm:pb-48 flex flex-col h-full">
        
        {/* Header */}
        <header className="mb-8 sm:mb-10 flex justify-between items-center">
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
          >
            <h1 className="text-3xl font-light tracking-tight flex items-center gap-3">
              <span className={cn("w-3 h-3 rounded-full animate-pulse shadow-[0_0_15px_rgba(0,0,0,0.5)]", activeColor)} />
              Aura <span className="opacity-20 font-black italic">PRO</span>
            </h1>
            <p className="text-[9px] uppercase tracking-[0.3em] opacity-40 font-bold mt-1">Nexus Protocol v4.0</p>
          </motion.div>
          <button 
            onClick={() => setActiveTab(activeTab === 'settings' ? 'chat' : 'settings')}
            className={cn(
              "p-3 rounded-2xl border border-white/5 hover:bg-white/5 transition-all active:scale-95",
              activeTab === 'settings' && "bg-white/10 border-white/20"
            )}
          >
            <Settings className={cn("w-5 h-5 transition-transform duration-500", activeTab === 'settings' && "rotate-180")} />
          </button>
        </header>

        {/* Dynamic Content */}
        <div className="flex-1 overflow-hidden relative min-h-0 flex flex-col">
          <AnimatePresence mode="wait">
            {activeTab === 'chat' && (
              <motion.div 
                key="chat"
                initial={{ opacity: 0, x: -10, filter: "blur(10px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: 10, filter: "blur(10px)" }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="flex flex-col h-full"
              >
                {/* Navigation & Search */}
                <div className="flex justify-between items-center mb-6">
                  <div className="flex gap-6">
                    {['chat', 'tasks'].map((tab) => (
                      <button 
                        key={tab}
                        onClick={() => setActiveTab(tab as any)}
                        className={cn(
                          "text-[10px] uppercase tracking-[0.2em] font-black pb-2 border-b-2 transition-all",
                          activeTab === tab ? cn("border-current", activeText) : "border-transparent opacity-30 hover:opacity-100"
                        )}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                  <div className="relative group/search">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 opacity-20 group-focus-within/search:opacity-60 transition-opacity" />
                    <input 
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="SEARCH MEMORY..."
                      className="bg-white/5 border border-white/10 rounded-full pl-8 pr-4 py-1.5 text-[8px] uppercase font-black tracking-widest focus:outline-none focus:border-white/20 transition-all w-24 sm:w-40"
                    />
                  </div>
                </div>

                <div 
                  ref={scrollRef}
                  className="flex-1 overflow-y-auto pr-2 space-y-6 scrollbar-hide"
                  style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 5%, black 95%, transparent 100%)' }}
                >
                  {history.length === 0 && !transcript && (
                    <div className="flex flex-col items-center justify-center h-full text-center space-y-8 py-10">
                      <div className="opacity-20 flex flex-col items-center space-y-4">
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ repeat: Infinity, duration: 20, ease: "linear" }}
                        >
                          <Globe className="w-16 h-16 animate-pulse" />
                        </motion.div>
                        <p className="text-xs uppercase tracking-widest leading-relaxed">System Standby<br/>Waiting for Neural Input</p>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-3 max-w-xs mx-auto opacity-70 w-full px-4">
                        <button 
                          onClick={() => {
                            const number = prompt("Enter phone number to call:");
                            if (number) handleUserCommand(`Call ${number}`);
                          }}
                          className="flex flex-col items-center justify-center p-4 bg-white/5 border border-white/10 rounded-2xl hover:bg-white/10 hover:opacity-100 transition-all active:scale-95"
                        >
                          <Phone className="w-5 h-5 mb-3" />
                          <span className="text-[9px] uppercase tracking-widest font-black">Make Call</span>
                        </button>
                        <button 
                          onClick={() => {
                            const number = prompt("Enter phone number for SMS:");
                            const message = prompt("Enter message:");
                            if (number && message) handleUserCommand(`Send SMS to ${number} saying '${message}'`);
                          }}
                          className="flex flex-col items-center justify-center p-4 bg-white/5 border border-white/10 rounded-2xl hover:bg-white/10 hover:opacity-100 transition-all active:scale-95"
                        >
                          <MessageSquare className="w-5 h-5 mb-3" />
                          <span className="text-[9px] uppercase tracking-widest font-black">Send SMS</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {history
                    .filter(h => h.text.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((msg, idx) => (
                    <motion.div 
                      key={idx}
                      initial={{ opacity: 0, y: 20, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ 
                        type: "spring",
                        stiffness: 260,
                        damping: 20,
                        delay: Math.min(idx * 0.05, 0.5) // Stagger for fresh history, capped
                      }}
                      className={cn(
                        "flex",
                        msg.role === 'user' ? "justify-end" : "justify-start"
                      )}
                    >
                      <div className={cn(
                        "max-w-[85%] px-5 py-3 rounded-2xl text-sm leading-relaxed transition-all duration-300",
                        msg.role === 'user' 
                          ? "bg-white/5 border border-white/5 font-medium text-white/90 hover:bg-white/10" 
                          : cn("bg-opacity-5 border backdrop-blur-md", activeShadow, activeBorder, "hover:bg-opacity-10")
                      )}>
                        {msg.image && (
                          <img src={msg.image} className="w-full max-w-xs object-cover rounded-xl mb-3 border border-white/10" alt="User upload" />
                        )}
                        <ReactMarkdown>{msg.text}</ReactMarkdown>
                      </div>
                    </motion.div>
                  ))}

                  {/* Neural Typing Indicators */}
                  {isProcessing && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="flex justify-start items-center gap-2 mb-2"
                    >
                      <div className={cn("w-6 h-6 rounded-full flex items-center justify-center", activeColor)}>
                        <Globe className="w-3 h-3 text-white animate-pulse" />
                      </div>
                      <div className="bg-white/5 border border-white/5 rounded-2xl px-4 py-2 flex gap-1.5 items-center">
                        <motion.div animate={{ scale: [1, 1.5, 1], opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: 0 }} className={cn("w-1.5 h-1.5 rounded-full", activeColor)} />
                        <motion.div animate={{ scale: [1, 1.5, 1], opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className={cn("w-1.5 h-1.5 rounded-full", activeColor)} />
                        <motion.div animate={{ scale: [1, 1.5, 1], opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className={cn("w-1.5 h-1.5 rounded-full", activeColor)} />
                        <span className="text-[8px] uppercase tracking-widest font-black opacity-30 ml-2">Neural Link Active</span>
                      </div>
                    </motion.div>
                  )}

                  {isUserTyping && (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex justify-end pr-4"
                    >
                      <p className="text-[8px] uppercase tracking-widest font-black opacity-20 flex items-center gap-2">
                        <Activity className="w-2 h-2 animate-pulse" /> Synaptic Transmission...
                      </p>
                    </motion.div>
                  )}

                  {transcript && (
                    <div className="flex justify-end">
                      <div className="max-w-[85%] px-5 py-3 rounded-2xl text-sm bg-white/5 border border-white/10 italic text-white/40">
                        {transcript}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {activeTab === 'tasks' && (
              <motion.div 
                key="tasks"
                initial={{ opacity: 0, y: 10, filter: "blur(10px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -10, filter: "blur(10px)" }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="flex flex-col h-full bg-white/5 rounded-3xl border border-white/5 p-6 backdrop-blur-xl"
              >
                <div className="flex justify-between items-center mb-6">
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={() => setActiveTab('chat')}
                      className="p-2 sm:p-3 rounded-full border border-white/5 bg-white/5 transition-all text-white/40 hover:text-white active:scale-95"
                    >
                      <ArrowLeft className="w-3 h-3 sm:w-4 sm:h-4" />
                    </button>
                    <h2 className="text-xs uppercase tracking-widest font-black opacity-40">Active Nodes</h2>
                  </div>
                  <button onClick={async () => {
                    if (user) {
                      const snapshot = await getDocs(collection(db, 'users', user.uid, 'tasks'))
                        .catch(e => handleFirestoreError(e, OperationType.LIST, `users/${user.uid}/tasks`));
                      if (snapshot) {
                        snapshot.forEach(async d => await deleteDoc(doc(db, 'users', user.uid, 'tasks', d.id))
                          .catch(e => handleFirestoreError(e, OperationType.DELETE, `users/${user.uid}/tasks/${d.id}`)));
                      }
                    }
                  }} className="text-[10px] opacity-40 hover:opacity-100 hover:text-red-400 flex items-center gap-1 transition-colors">
                    <Trash2 className="w-3 h-3" /> Clear Nodes
                  </button>
                </div>

                {/* Quick Add Node */}
                <form 
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const input = (e.currentTarget.elements.namedItem('nodeValue') as HTMLInputElement);
                    if (input.value.trim() && user) {
                      const taskData = { 
                        id: crypto.randomUUID(),
                        type: 'MANUAL_ENTRY', 
                        value: input.value.trim(), 
                        time: 0, 
                        userId: user.uid, 
                        createdAt: serverTimestamp() 
                      };
                      await addDoc(collection(db, 'users', user.uid, 'tasks'), taskData)
                        .catch(err => handleFirestoreError(err, OperationType.CREATE, `users/${user.uid}/tasks`));
                      input.value = '';
                    }
                  }}
                  className="mb-6 flex gap-2"
                >
                  <input 
                    name="nodeValue"
                    type="text"
                    placeholder="RAPID UPLINK..."
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-[10px] uppercase font-black tracking-widest focus:outline-none focus:border-white/30 transition-all placeholder:text-white/10"
                  />
                  <button 
                    type="submit"
                    className={cn("px-4 py-2 rounded-xl text-[10px] uppercase font-black tracking-widest transition-all", activeColor, "hover:opacity-80")}
                  >
                    Add
                  </button>
                </form>
                
                {tasks.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-center opacity-20 py-20">
                    <History className="w-12 h-12 mb-4" />
                    <p className="text-[10px] uppercase tracking-widest font-bold">Node Stack Empty</p>
                  </div>
                ) : (
                  <div className="space-y-3 overflow-y-auto pr-2">
                    <AnimatePresence initial={false}>
                      {tasks.map((task, idx) => (
                        <motion.div 
                          key={task.id}
                          layout
                          initial={{ opacity: 0, scale: 0.95, y: 20 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.9, x: 20 }}
                          transition={{ 
                            type: "spring",
                            stiffness: 300,
                            damping: 25,
                            delay: Math.min(idx * 0.05, 0.3)
                          }}
                          className="p-4 rounded-2xl bg-white/5 border border-white/5 flex items-center gap-4 group transition-all hover:bg-white/[0.07]"
                        >
                          <div className={cn("p-2 rounded-xl border", activeBorder)}>
                            {task.type === 'SET_TIMER' ? <div className="w-4 h-4 flex items-center justify-center font-mono text-[9px] font-black">{task.remaining}s</div> : <Globe className="w-4 h-4" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-xs font-bold uppercase tracking-widest truncate">{task.type.replace('_', ' ')}</p>
                              {task.dueAt && (
                                <div className={cn(
                                  "px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-tighter",
                                  new Date(task.dueAt).getTime() - Date.now() < 3600000 
                                    ? "bg-red-500/20 text-red-500 animate-pulse border border-red-500/30"
                                    : "bg-white/10 text-white/40"
                                )}>
                                  {new Date(task.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </div>
                              )}
                            </div>
                            <p className="text-[10px] opacity-40 truncate">{task.value}</p>
                          </div>
                          <button 
                            onClick={async () => {
                              playCompleteSound();
                              if (user) {
                                setCompletingTasks(prev => new Set([...prev, task.id]));
                                // Delay deletion for animation
                                setTimeout(async () => {
                                  await deleteDoc(doc(db, 'users', user.uid, 'tasks', task.id))
                                    .catch(e => handleFirestoreError(e, OperationType.DELETE, `users/${user.uid}/tasks/${task.id}`));
                                  setCompletingTasks(prev => {
                                    const next = new Set(prev);
                                    next.delete(task.id);
                                    return next;
                                  });
                                }, 600);
                              }
                            }}
                            className="opacity-0 group-hover:opacity-100 p-2 text-white/30 hover:text-green-500 transition-all relative"
                            title="Complete Task"
                          >
                            <AnimatePresence>
                              {completingTasks.has(task.id) && (
                                <motion.div
                                  initial={{ scale: 0, opacity: 0 }}
                                  animate={{ scale: 2, opacity: 1 }}
                                  exit={{ scale: 4, opacity: 0 }}
                                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                                >
                                  <div className="w-1 h-1 bg-green-500 rounded-full" />
                                </motion.div>
                              )}
                            </AnimatePresence>
                            <Check className={cn("w-4 h-4 transition-all", completingTasks.has(task.id) && "scale-150 text-green-500")} />
                          </button>
                          <button 
                            onClick={async () => {
                              if (user) {
                                await deleteDoc(doc(db, 'users', user.uid, 'tasks', task.id))
                                  .catch(e => handleFirestoreError(e, OperationType.DELETE, `users/${user.uid}/tasks/${task.id}`));
                              }
                            }}
                            className="opacity-0 group-hover:opacity-100 p-2 text-white/30 hover:text-red-500 transition-all"
                            title="Delete Task"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'admin' && isAdmin && (
              <AdminPanel 
                 onClose={() => setActiveTab('settings')} 
                 activeColor={activeColor}
                 activeText={activeText}
                 activeBorder={activeBorder}
              />
            )}

            {activeTab === 'settings' && (
              <motion.div 
                key="settings"
                initial={{ opacity: 0, x: 20, filter: "blur(10px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: 20, filter: "blur(10px)" }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="flex flex-col h-full space-y-8 bg-white/5 rounded-3xl border border-white/5 p-6 backdrop-blur-3xl overflow-y-auto"
              >
                <div className="flex justify-between items-center">
                  <h2 className={cn("text-xs uppercase tracking-[0.3em] font-black", activeText)}>System Core</h2>
                  <div className="flex gap-2">
                    {isAdmin && (
                      <button 
                        onClick={() => setActiveTab('admin')}
                        className="px-3 py-2 rounded-xl bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 text-[10px] font-black tracking-widest uppercase hover:bg-cyan-500/30 transition-all flex items-center gap-1"
                      >
                        <ShieldAlert className="w-3 h-3" /> Admin
                      </button>
                    )}
                    <button onClick={() => setActiveTab('chat')} className="text-[10px] opacity-40 hover:opacity-100 flex items-center gap-1 transition-all">
                      Exit Core
                    </button>
                  </div>
                </div>

                <div className="space-y-6">
                  {/* User Profile */}
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                    className="space-y-4"
                  >
                    {isCameraActive ? (
                      <div className="relative w-full aspect-square max-h-64 sm:max-h-80 rounded-3xl overflow-hidden bg-black/80 border-2 border-white/10 flex flex-col items-center justify-center">
                        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                        <div className="absolute inset-x-0 bottom-0 p-4 pb-6 flex justify-center items-center gap-8 bg-gradient-to-t from-black/80 to-transparent">
                          <button onClick={stopCamera} className="p-4 bg-white/10 backdrop-blur-md rounded-full text-white/70 hover:text-white hover:bg-white/20 transition-all active:scale-95">
                            <X className="w-6 h-6" />
                          </button>
                          <button onClick={capturePhoto} className="p-4 bg-white text-black rounded-full shadow-[0_0_20px_rgba(255,255,255,0.4)] hover:shadow-[0_0_30px_rgba(255,255,255,0.6)] transition-all active:scale-95">
                            <Camera className="w-8 h-8" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                        <div className="relative group shrink-0">
                          <div className="w-16 h-16 rounded-full overflow-hidden bg-white/5 flex items-center justify-center border-2 border-white/10 group-hover:border-white/30 transition-colors">
                            {settings.profilePic ? (
                              <img src={settings.profilePic} className="w-full h-full object-cover" alt="Profile" />
                            ) : (
                              <Activity className="w-8 h-8 opacity-30" />
                            )}
                          </div>
                          <button 
                            onClick={startCamera}
                            className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center rounded-full transition-opacity cursor-pointer"
                          >
                            <Camera className="w-6 h-6 text-white" />
                          </button>
                        </div>
                        <div className="flex-1 w-full space-y-3">
                          <label className="text-[10px] uppercase tracking-widest font-black opacity-30">Identity Alias</label>
                          <input 
                            type="text" 
                            value={settings.userName}
                            onChange={(e) => setSettings({ ...settings, userName: e.target.value })}
                            className="w-full bg-white/5 border border-white/5 rounded-2xl px-5 py-3 text-sm focus:outline-none focus:border-white/20 transition-all"
                            placeholder="Input Name"
                          />
                        </div>
                      </div>
                    )}

                    {/* Neural Analytics */}
                    <div className="grid grid-cols-2 gap-3 pt-2">
                      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-col items-center justify-center gap-1 group hover:bg-white/[0.08] transition-all">
                        <span className="text-[8px] uppercase tracking-widest font-black opacity-30">Synaptic Linkage</span>
                        <span className={cn("text-xl font-bold tracking-tighter", activeText)}>{history.length}</span>
                        <span className="text-[7px] uppercase font-bold opacity-20">Traces Cached</span>
                      </div>
                      <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-col items-center justify-center gap-1 group hover:bg-white/[0.08] transition-all">
                        <span className="text-[8px] uppercase tracking-widest font-black opacity-30">Node Clusters</span>
                        <span className={cn("text-xl font-bold tracking-tighter", activeText)}>{tasks.length}</span>
                        <span className="text-[7px] uppercase font-bold opacity-20">Active Uplinks</span>
                      </div>
                    </div>
                  </motion.div>

                    {/* Neural Theme */}
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2 }}
                      className="space-y-3"
                    >
                      <label className="text-[10px] uppercase tracking-widest font-black opacity-30">Neural Theme</label>
                      <div className="grid grid-cols-3 gap-2">
                        {['cyan', 'purple', 'green', 'forest', 'ocean', 'minimalist'].map(theme => (
                          <motion.button 
                            key={theme}
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                            onClick={() => setSettings({ ...settings, theme })}
                            className={cn(
                              "py-3 rounded-2xl border transition-all text-[10px] uppercase font-black tracking-widest",
                              settings.theme === theme 
                                ? cn("bg-white/10 border-white/20 shadow-lg", activeText, activeShadow)
                                : "bg-white/5 border-transparent opacity-40 hover:opacity-70"
                            )}
                          >
                            {theme}
                          </motion.button>
                        ))}
                      </div>

                      {/* Custom Accent Color */}
                      <div className="pt-2">
                        <label className="text-[8px] uppercase tracking-widest font-black opacity-20 mb-2 block">Neural Tint</label>
                        <div className="flex items-center gap-4">
                          <input 
                            type="color" 
                            value={settings.accentColor || '#06b6d4'}
                            onChange={(e) => setSettings({ ...settings, accentColor: e.target.value })}
                            className="bg-transparent border-none w-8 h-8 rounded cursor-pointer [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-lg [&::-webkit-color-swatch]:border-none shadow-lg"
                          />
                          <p className="text-[10px] font-mono opacity-30 tracking-widest">{settings.accentColor?.toUpperCase()}</p>
                        </div>
                      </div>
                    </motion.div>

                  {/* Voice Speed */}
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                    className="space-y-3"
                  >
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] uppercase tracking-widest font-black opacity-30">Neural Rate</label>
                      <span className="text-[10px] font-mono opacity-60">{settings.voiceSpeed}x</span>
                    </div>
                    <input 
                      type="range" 
                      min="0.5" 
                      max="1.5" 
                      step="0.05"
                      value={settings.voiceSpeed}
                      onChange={(e) => setSettings({ ...settings, voiceSpeed: parseFloat(e.target.value) })}
                      className={cn("w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-current", activeText)}
                    />
                  </motion.div>

                  {/* Voice Pitch */}
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.4 }}
                    className="space-y-3"
                  >
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] uppercase tracking-widest font-black opacity-30">Neural Pitch</label>
                      <span className="text-[10px] font-mono opacity-60">{settings.voicePitch}</span>
                    </div>
                    <input 
                      type="range" 
                      min="0.5" 
                      max="2.0" 
                      step="0.1"
                      value={settings.voicePitch}
                      onChange={(e) => setSettings({ ...settings, voicePitch: parseFloat(e.target.value) })}
                      className={cn("w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-current", activeText)}
                    />
                  </motion.div>

                  {/* Auto-Listen Toggle */}
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.5 }}
                    className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-2xl"
                  >
                    <div>
                      <h3 className="text-xs uppercase tracking-widest font-black opacity-80">Auto-Listen Mode</h3>
                      <p className="text-[10px] opacity-40 mt-1">Say "Aura" to wake assistant</p>
                    </div>
                    <button 
                      onClick={() => {
                        const newAutoListen = !settings.autoListen;
                        setSettings({ ...settings, autoListen: newAutoListen });
                        if (newAutoListen) {
                          try { recognitionRef.current?.start(); } catch(e) {}
                        } else {
                          try { recognitionRef.current?.stop(); } catch(e) {}
                        }
                      }}
                      className={cn(
                        "w-12 h-6 rounded-full transition-colors relative",
                        settings.autoListen ? activeColor : "bg-white/10"
                      )}
                    >
                      <div className={cn(
                        "w-4 h-4 bg-white rounded-full absolute top-1 transition-all",
                        settings.autoListen ? "left-7" : "left-1"
                      )} />
                    </button>
                  </motion.div>

                  {/* Auto-Listen Sensitivity Slider */}
                  {settings.autoListen && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="space-y-3 p-4 bg-white/5 border border-white/5 rounded-2xl"
                    >
                      <div className="flex justify-between items-center">
                        <label className="text-[10px] uppercase tracking-widest font-black opacity-30">Wake Word Sensitivity</label>
                        <span className="text-[10px] font-mono opacity-60">Level {settings.autoListenSensitivity || 3}</span>
                      </div>
                      <input 
                        type="range" 
                        min="1" 
                        max="5" 
                        step="1"
                        value={settings.autoListenSensitivity || 3}
                        onChange={(e) => setSettings({ ...settings, autoListenSensitivity: parseInt(e.target.value) })}
                        className={cn("w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-current", activeText)}
                      />
                      <div className="flex justify-between text-[8px] uppercase tracking-widest opacity-30 mt-1">
                        <span>Strict</span>
                        <span>Loose</span>
                      </div>
                    </motion.div>
                  )}

                  {/* Haptic Feedback Setting */}
                  <div className="flex items-center justify-between p-4 bg-white/5 border border-white/5 rounded-2xl group transition-colors hover:bg-white/10">
                    <div>
                      <h4 className="text-sm font-bold text-white group-hover:text-cyan-400 transition-colors flex items-center gap-2">
                        <Activity className="w-4 h-4" /> Haptic Feedback
                      </h4>
                      <p className="text-[10px] text-white/40 mt-1 uppercase tracking-widest font-black">Vibrate on actions</p>
                    </div>
                    <button 
                      onClick={() => setSettings(s => ({ ...s, hapticFeedback: !s.hapticFeedback }))}
                      className={cn(
                        "w-12 h-6 rounded-full transition-colors relative",
                        settings.hapticFeedback ? activeColor : "bg-white/10"
                      )}
                    >
                      <div className={cn(
                        "w-4 h-4 bg-white rounded-full absolute top-1 transition-all",
                        settings.hapticFeedback ? "left-7" : "left-1"
                      )} />
                    </button>
                  </div>

                  {/* Device Status Dashboard */}
                  <div className="space-y-3">
                    <label className="text-[10px] uppercase tracking-widest font-black opacity-30">Real-Time Diagnostics</label>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-4 bg-white/5 border border-white/5 rounded-2xl flex flex-col gap-2">
                        <div className="flex items-center gap-2 opacity-50 text-[10px] uppercase tracking-widest font-black">
                          <Wifi className="w-3 h-3" />
                          <span>Network</span>
                        </div>
                        <div className="text-lg font-mono font-bold tracking-tight text-white flex items-center gap-2">
                          <div className={cn("w-2 h-2 rounded-full", deviceStats.online ? "bg-green-500 animate-pulse" : "bg-red-500")} />
                          {deviceStats.networkType}
                        </div>
                        <div className="text-xs font-mono opacity-40">{deviceStats.networkSpeed}</div>
                      </div>

                      <div className="p-4 bg-white/5 border border-white/5 rounded-2xl flex flex-col gap-2">
                        <div className="flex items-center gap-2 opacity-50 text-[10px] uppercase tracking-widest font-black">
                          <Battery className="w-3 h-3" />
                          <span>Power Array</span>
                        </div>
                        <div className="text-lg font-mono font-bold tracking-tight text-white flex items-center gap-2">
                          {deviceStats.battery}%
                        </div>
                        <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden mt-1">
                          <div 
                            className={cn(
                              "h-full rounded-full transition-all duration-1000",
                              deviceStats.battery <= 20 ? "bg-red-500" : "bg-cyan-400"
                            )}
                            style={{ width: `${deviceStats.battery}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Reset Control */}
                  <div className="flex flex-col gap-3">
                    <button 
                      onClick={() => {
                        if (confirm('Clear entire chat history?')) {
                          setHistory([]);
                          setTasks([]);
                          setActiveTab('chat');
                        }
                      }}
                      className="w-full mt-4 py-5 rounded-2xl bg-red-500/20 border border-red-500/30 text-red-500 text-xs uppercase tracking-[0.2em] font-black hover:bg-red-500/30 transition-all active:scale-95 flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(239,68,68,0.2)]"
                    >
                      <Trash2 className="w-4 h-4" /> Clear Chat History
                    </button>

                    <button 
                      onClick={handleLogout}
                      className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-white/40 text-xs uppercase tracking-[0.2em] font-black hover:bg-white/10 transition-all active:scale-95 flex items-center justify-center gap-2"
                    >
                      <LogOut className="w-4 h-4" /> Logout from Nexus
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Global Controls */}
        <div className="fixed bottom-0 left-0 w-full px-4 sm:px-6 pb-6 sm:pb-10 pt-8 sm:pt-12 bg-gradient-to-t from-[#050505] via-[#050505]/95 to-transparent pointer-events-none z-50">
          <div className="max-w-lg mx-auto flex flex-col items-center gap-4 sm:gap-6 pointer-events-auto">
            {error && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full bg-red-500/10 border border-red-500/20 px-4 py-3 rounded-2xl text-[10px] text-red-400 font-mono tracking-wider flex justify-between items-center"
              >
                <span>{error}</span>
                <button onClick={() => setError(null)} className="opacity-60 hover:opacity-100">DISMISS</button>
              </motion.div>
            )}

            <div className="flex items-center gap-4 sm:gap-8">
              <button 
                onClick={stopSpeaking}
                className={cn(
                  "p-3 sm:p-4 rounded-full border border-white/5 bg-white/5 transition-all active:scale-90",
                  isSpeaking ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"
                )}
              >
                <VolumeX className="w-5 h-5 sm:w-6 sm:h-6 text-red-500" />
              </button>

              <button 
                onClick={toggleListening}
                className={cn(
                  "relative p-6 sm:p-8 rounded-full transition-all duration-500 active:scale-90 shadow-2xl",
                  isListening 
                    ? cn("bg-red-500/10 ring-4 ring-red-500/20", activeShadow) 
                    : cn("bg-white/5 backdrop-blur-xl border border-white/10 hover:border-white/30", activeShadow),
                  wakeDetected && cn("shadow-[0_0_40px_rgba(34,211,238,0.5)] ring-4 ring-cyan-400 bg-cyan-900/40")
                )}
              >
                {wakeDetected && (
                  <div className="absolute inset-0 rounded-full animate-ping bg-cyan-400/40 pointer-events-none" />
                )}
                {isListening && !wakeDetected && (
                  <div className="absolute inset-0 rounded-full animate-ping bg-red-500/20 pointer-events-none" />
                )}
                <div className={cn("transition-transform duration-500", isListening && "scale-110")}>
                  {isListening ? (
                    <MicOff className="w-6 h-6 sm:w-8 sm:h-8 text-red-500" />
                  ) : (
                    <Mic className={cn("w-6 h-6 sm:w-8 sm:h-8", activeText)} />
                  )}
                </div>
              </button>

              <button 
                onClick={() => setShowInput(!showInput)}
                className="p-3 sm:p-4 rounded-full border border-white/5 bg-white/5 transition-all text-white/30 hover:text-white active:scale-90"
              >
                <MessageSquare className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>

              <button 
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = 'image/*';
                  input.capture = 'environment';
                  input.onchange = (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onload = (ev) => {
                        const imgBase64 = ev.target?.result as string;
                        handleUserCommand('', imgBase64);
                      };
                      reader.readAsDataURL(file);
                    }
                  };
                  input.click();
                }}
                className="p-3 sm:p-4 rounded-full border border-white/5 bg-white/5 transition-all text-white/30 hover:text-white active:scale-90"
              >
                <Camera className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>
            </div>
            
            <AnimatePresence>
              {showInput && (
                <motion.form 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  onSubmit={handleTextInput}
                  className="w-full flex gap-3"
                >
                  <input 
                    type="text" 
                    value={inputText}
                    onChange={(e) => {
                      setInputText(e.target.value);
                      setIsUserTyping(true);
                      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                      typingTimeoutRef.current = setTimeout(() => setIsUserTyping(false), 1500);
                    }}
                    placeholder="Input Neural Query..."
                    className="flex-1 bg-white/5 border border-white/10 rounded-2xl px-5 py-4 text-sm focus:outline-none focus:border-white/30 transition-all placeholder:text-white/20"
                    autoFocus
                  />
                </motion.form>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      <style>{`
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
    </div>
  );
}
