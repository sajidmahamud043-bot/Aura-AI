/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, MicOff, Volume2, VolumeX, Settings, MessageSquare, History, Globe, Battery, Wifi, Signal, Trash2, ArrowLeft, Check, Activity, Camera, X, ShieldAlert, Zap, Search, UserCircle, Menu, Plus, Paperclip, Send, FileText, Table, Presentation, FileArchive, File as LucideFile } from 'lucide-react';
import { getAssistantResponse } from './services/geminiService';
import { cn } from './lib/utils';
import ReactMarkdown from 'react-markdown';
import UserProfile from './components/UserProfile';
import { auth, db, storage, ref, uploadBytes, getDownloadURL, onAuthStateChanged, collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, doc, setDoc, getDocs, deleteDoc } from './lib/firebase';

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
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isHoldToTalk, setIsHoldToTalk] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [sessionGreeted, setSessionGreeted] = useState(false);
  const [completingTasks, setCompletingTasks] = useState<Set<string>>(new Set());
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [history, setHistory] = useState<{ role: 'user' | 'model', text: string, image?: string | null, files?: { url: string, name: string, type: string }[] }[]>([]);
  const [tasks, setTasks] = useState<{ id: string; type: string; value: string; time: number; remaining?: number; dueAt?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isUserTyping, setIsUserTyping] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<{ id: string, file: File, preview?: string, type: 'image' | 'pdf' | 'doc' | 'sheet' | 'slide' | 'archive' | 'other', caption?: string }[]>([]);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestTranscriptRef = useRef('');
  const isActuallyListeningRef = useRef(false);

  const clearError = () => setError(null);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const [deviceStats, setDeviceStats] = useState({ battery: 100, online: navigator.onLine, location: 'Scanning...', networkType: 'WiFi', networkSpeed: 'Fast' });
  const [activeTab, setActiveTab] = useState<'chat' | 'tasks' | 'settings' | 'profile'>('chat');
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });

    return () => unsubscribe();
  }, []);

  const [wakeDetected, setWakeDetected] = useState(false);
  const [systemConfig, setSystemConfig] = useState<any>({
    features: {
      aiChat: true,
      voiceCommands: true,
      realtimeSync: false
    },
    maintenance: false
  });
  const wakeTriggeredRef = useRef(false);

  // Sync System Config - Disabled to avoid permission errors (only using Google Auth now)
  /*
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'system', 'config'), (snap) => {
      if (snap.exists()) setSystemConfig(snap.data());
    }, (err) => handleFirestoreError(err, OperationType.GET, 'system/config'));
    return () => unsub();
  }, []);
  */
  
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraZoom, setCameraZoom] = useState(1);
  const [hasZoomSupport, setHasZoomSupport] = useState(false);
  const [cameraCapabilities, setCameraCapabilities] = useState<any>(null);
  const [cameraMode, setCameraMode] = useState<'profile' | 'chat'>('chat');
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

  // Settings with Persistence (Local initial, synced via useEffect)
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
      autoListenSensitivity: 3, 
      hapticFeedback: true,
      ...parsed
    };
  });

  const settingsRef = useRef(settings);
  const isSpeakingRef = useRef(isSpeaking);
  const isHoldToTalkRef = useRef(isHoldToTalk);

  // Sync History, Tasks and Settings with Database when logged in
  useEffect(() => {
    if (!user) {
      // If not logged in, load from local storage
      const savedTasks = localStorage.getItem(`aura_tasks_local`);
      if (savedTasks) setTasks(JSON.parse(savedTasks));
      
      const savedHistory = localStorage.getItem(`aura_history_local`);
      if (savedHistory) setHistory(JSON.parse(savedHistory));
      return;
    }

    let unsubSettings: () => void = () => {};
    let unsubHistory: () => void = () => {};
    let unsubTasks: () => void = () => {};

    // Firebase Syncer
    // Load Settings from Firestore
    const userDocRef = doc(db, 'users', user.uid);
    const unsubS = onSnapshot(userDocRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setSettings(prev => ({
          ...prev,
          userName: data.userName || user.displayName || 'Sajid',
          profilePic: data.profilePic || '',
          ...data.settings
        }));
      }
    });
    unsubSettings = unsubS;

    // Load History from Firestore
    const historyQuery = query(
      collection(db, 'users', user.uid, 'history'),
      orderBy('createdAt', 'asc')
    );

    const unsubH = onSnapshot(historyQuery, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({
        role: doc.data().role,
        text: doc.data().text,
        image: doc.data().image,
        files: doc.data().files || []
      }));
      setHistory(docs as any);
    });
    unsubHistory = unsubH;

    // Load Tasks from Firestore
    const tasksQuery = query(
      collection(db, 'users', user.uid, 'tasks'),
      orderBy('time', 'desc')
    );

    const unsubT = onSnapshot(tasksQuery, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setTasks(docs as any);
    });
    unsubTasks = unsubT;

    return () => {
      unsubSettings();
      unsubHistory();
      unsubTasks();
    };
  }, [user]);

  // Persist to LocalStorage only if not logged in
  useEffect(() => {
    if (!user) {
      localStorage.setItem(`aura_tasks_local`, JSON.stringify(tasks));
    }
  }, [tasks, user]);

  useEffect(() => {
    if (!user) {
      localStorage.setItem(`aura_history_local`, JSON.stringify(history));
    }
  }, [history, user]);

  // Persist Settings to Firestore and LocalStorage
  useEffect(() => {
    settingsRef.current = settings;
    localStorage.setItem('aura_settings', JSON.stringify(settings));
    
    if (user) {
      const { userName, profilePic, ...otherSettings } = settings;
      setDoc(doc(db, 'users', user.uid), {
        userName,
        profilePic,
        settings: otherSettings,
        updatedAt: serverTimestamp()
      }, { merge: true });
    }
  }, [settings, user]);

  // Personalized Greeting on Start
  useEffect(() => {
    const hasGreeted = sessionStorage.getItem('aura_initial_greet');
    if (!hasGreeted && settings.userName) {
      const greetingText = `Hello, I'm Aura AI, how can I help you ${settings.userName}?`;
      
      // Delay slightly for smooth entrance
      const timer = setTimeout(() => {
        setHistory(prev => [...prev, { role: 'model', text: greetingText }]);
        
        // AI speaks the greeting
        const utterance = new SpeechSynthesisUtterance(greetingText);
        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        window.speechSynthesis.speak(utterance);
        
        sessionStorage.setItem('aura_initial_greet', 'true');
      }, 3000); // 3s delay to ensure everything is loaded
      
      return () => clearTimeout(timer);
    }
  }, [settings.userName]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    files.forEach(file => {
      const name = file.name.toLowerCase();
      const mime = file.type.toLowerCase();
      
      let type: 'image' | 'pdf' | 'doc' | 'sheet' | 'slide' | 'archive' | 'other' = 'other';
      
      if (mime.startsWith('image/')) {
        type = 'image';
      } else if (mime === 'application/pdf' || name.endsWith('.pdf')) {
        type = 'pdf';
      } else if (mime.includes('word') || mime.includes('text') || name.endsWith('.doc') || name.endsWith('.docx') || name.endsWith('.txt') || name.endsWith('.rtf')) {
        type = 'doc';
      } else if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv') || name.endsWith('.xls') || name.endsWith('.xlsx') || name.endsWith('.csv')) {
        type = 'sheet';
      } else if (mime.includes('presentation') || mime.includes('powerpoint') || name.endsWith('.ppt') || name.endsWith('.pptx')) {
        type = 'slide';
      } else if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('7z') || name.endsWith('.zip') || name.endsWith('.rar')) {
        type = 'archive';
      }

      const newFileObj: any = {
        id: Math.random().toString(36).substr(2, 9),
        file,
        type,
        caption: ''
      };

      if (type === 'image') {
        const reader = new FileReader();
        reader.onloadend = () => {
          newFileObj.preview = reader.result as string;
          setSelectedFiles(prev => [...prev, newFileObj]);
        };
        reader.readAsDataURL(file);
      } else {
        setSelectedFiles(prev => [...prev, newFileObj]);
      }
    });

    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const updateFileCaption = (id: string, caption: string) => {
    setSelectedFiles(prev => prev.map(f => f.id === id ? { ...f, caption } : f));
  };

  const removeFile = (id: string) => {
    setSelectedFiles(prev => prev.filter(f => f.id !== id));
  };

  useEffect(() => {
    isSpeakingRef.current = isSpeaking;
  }, [isSpeaking]);

  useEffect(() => {
    isHoldToTalkRef.current = isHoldToTalk;
  }, [isHoldToTalk]);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const synthesisRef = useRef<SpeechSynthesisUtterance | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [isUploading, setIsUploading] = useState(false);

  const uploadFileToStorage = async (fileOrBlob: File | Blob, folder: string) => {
    if (!user) return null;
    try {
      setIsUploading(true);
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const fileRef = ref(storage, `users/${user.uid}/${folder}/${fileName}`);
      const snapshot = await uploadBytes(fileRef, fileOrBlob);
      const url = await getDownloadURL(snapshot.ref);
      return url;
    } catch (error) {
      console.error("Storage upload failed:", error);
      return null;
    } finally {
      setIsUploading(false);
    }
  };

  const handleTextInput = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() && selectedFiles.length === 0) return;
    
    let textToSend = inputText.trim();
    const uploadedFiles: { url: string, name: string, type: string, caption?: string }[] = [];

    // Process all files
    for (const f of selectedFiles) {
      let finalUrl = f.preview || '';
      
      if (user) {
        const folder = f.type === 'image' ? 'chat_images' : 'chat_files';
        const uploadedUrl = await uploadFileToStorage(f.file, folder);
        if (uploadedUrl) finalUrl = uploadedUrl;
      }
      
      uploadedFiles.push({
        url: finalUrl,
        name: f.file.name,
        type: f.type,
        caption: f.caption
      });
    }

    // Combine text and captions
    let combinedText = textToSend;
    const captions = selectedFiles
      .filter(f => f.caption && f.caption.trim())
      .map(f => `File: ${f.file.name}\nCaption: ${f.caption}`)
      .join('\n\n');

    if (captions) {
      combinedText = combinedText ? `${combinedText}\n\n${captions}` : captions;
    }

    // Default text if nothing else
    if (!combinedText && selectedFiles.length > 0) {
      combinedText = `[Sent ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}]`;
    }

    // For vision: we use the first image only for now as per geminiService limit
    const imageFile = selectedFiles.find(f => f.type === 'image');
    let visionBase64 = imageFile?.preview || '';
    let firstImageUrl = uploadedFiles.find(f => f.type === 'image')?.url || visionBase64;

    handleUserCommand(combinedText, firstImageUrl, 'text', visionBase64, uploadedFiles);
    setInputText('');
    setSelectedFiles([]);
    setShowInput(false);
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
      recognition.continuous = true; 
      recognition.interimResults = true;
      recognition.lang = 'en-US'; 

      recognition.onstart = () => {
        setIsListening(true);
        isActuallyListeningRef.current = true;
        latestTranscriptRef.current = '';
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        const current = finalTranscript || interimTranscript;
        setTranscript(current);
        latestTranscriptRef.current = current;
        
        // If we have a final result, we process it but with a slight delay
        if (finalTranscript) {
          let commandToProcess = finalTranscript;

          // Debounce the final command processing
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = setTimeout(() => {
            // Only auto-submit if not in hold-to-talk mode
            if (!isHoldToTalkRef.current) {
               handleUserCommand(commandToProcess, undefined, 'voice');
               try { recognitionRef.current?.stop(); } catch(e) {}
            }
          }, 1500); 
        }
      };

      recognition.onerror = (event: any) => {
        if (['no-speech', 'aborted', 'audio-capture'].includes(event.error)) {
          console.warn('Speech engine warning:', event.error);
          setIsListening(false);
          isActuallyListeningRef.current = false;
          return;
        }
        console.error('Recognition error:', event.error);
        setError(`System Alert: ${event.error}`);
        setIsListening(false);
        isActuallyListeningRef.current = false;
      };

      recognition.onend = () => {
        setIsListening(false);
        isActuallyListeningRef.current = false;
        setIsHoldToTalk(false);
      };

      recognitionRef.current = recognition;
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

  const startCamera = async (mode: 'profile' | 'chat' = 'chat') => {
    setCameraMode(mode);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError("Your browser does not support camera access. Please use a modern browser like Chrome, Edge, or Safari.");
      return;
    }

    try {
      // Clear previous error
      setError(null);
      
      // Attempt to stop existing stream if any
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }

      // Try with preferred constraints first
      let stream;
      try {
        // We use ideal values to allow browser to downscale
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            facingMode: 'user', 
            width: { ideal: 1280 }, 
            height: { ideal: 720 }
          } 
        });
      } catch (e: any) {
        console.warn("Primary camera constraints failed, retrying with minimal constraints...", e);
        // Try with absolutely minimal constraints
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        } catch (e2: any) {
          // If even basic video fails, try one more time without any specific requirements
          console.warn("Minimal constraints failed, one last try...", e2);
          throw e2; 
        }
      }

      streamRef.current = stream;
      
      // Get camera capabilities for zoom/focus
      const track = stream.getVideoTracks()[0];
      if (track && typeof track.getCapabilities === 'function') {
        try {
          const capabilities = track.getCapabilities() as any;
          setCameraCapabilities(capabilities);
          if (capabilities.zoom) {
            setHasZoomSupport(true);
            setCameraZoom(capabilities.zoom.min || 1);
          }
        } catch (capErr) {
          console.warn("Failed to get camera capabilities:", capErr);
        }
      }

      setIsCameraActive(true);
      
      // Delay assignment slightly to ensure video element is mounted in the DOM
      setTimeout(() => {
        if (videoRef.current && streamRef.current) {
          videoRef.current.srcObject = streamRef.current;
        }
      }, 500);

    } catch (err: any) {
      console.error("Camera access denied or unavailable", err);
      let msg = "Unable to access the camera.";
      const errName = err.name || '';
      const errMsg = err.message || '';
      
      if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError' || errMsg.toLowerCase().includes('not found') || errMsg.toLowerCase().includes('object can not be found')) {
        msg = "No camera device detected. Please connect a camera and try again.";
      } else if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError' || errMsg.toLowerCase().includes('denied')) {
        msg = "Camera permission denied. Please allow camera access in your browser settings.";
      } else if (errName === 'NotReadableError' || errName === 'TrackStartError') {
        msg = "Camera is already in use by another application or tab.";
      } else if (errName === 'OverconstrainedError') {
        msg = "The requested camera settings are not supported by your device.";
      } else if (window.self !== window.top) {
        msg = "Camera access blocked by security restrictions. Try opening the app in a new tab.";
      } else {
        msg = `Camera Error: ${errMsg || errName || 'Unknown error'}`;
      }
      setError(msg);
      setIsCameraActive(false);
    }
  };

  const applyZoom = async (value: number) => {
    setCameraZoom(value);
    if (streamRef.current) {
      const track = streamRef.current.getVideoTracks()[0];
      if (track && 'applyConstraints' in track) {
        try {
          await track.applyConstraints({
            // @ts-ignore
            advanced: [{ zoom: value }]
          });
        } catch (e) {
          console.warn("Zoom not supported by track constraints", e);
        }
      }
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
    setCameraCapabilities(null);
    setHasZoomSupport(false);
    setCameraZoom(1);
  }, []);

  const capturePhoto = () => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Visual flash overlay
        const flash = document.createElement('div');
        flash.className = 'fixed inset-0 bg-white z-[1000] pointer-events-none opacity-100';
        document.body.appendChild(flash);
        setTimeout(() => {
          flash.style.transition = 'opacity 0.4s ease-out';
          flash.style.opacity = '0';
          setTimeout(() => document.body.removeChild(flash), 400);
        }, 50);

        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        
        if (cameraMode === 'profile') {
          // If logged in, upload profile pic to storage
          if (user) {
            canvas.toBlob(async (blob) => {
              if (blob) {
                const uploadedUrl = await uploadFileToStorage(blob, 'profile_pics');
                if (uploadedUrl) {
                  setSettings({ ...settings, profilePic: uploadedUrl });
                }
              }
              stopCamera();
            }, 'image/jpeg', 0.9);
          } else {
            setSettings({ ...settings, profilePic: dataUrl });
            stopCamera();
          }
        } else {
          // Chat mode capture - just add to selection, handleTextInput will upload
          const fileId = Math.random().toString(36).substr(2, 9);
          fetch(dataUrl)
            .then(res => res.blob())
            .then(blob => {
              const file = new File([blob], `capture_${Date.now()}.jpg`, { type: 'image/jpeg' });
              setSelectedFiles(prev => [...prev, {
                id: fileId,
                file,
                preview: dataUrl,
                type: 'image'
              }]);
              stopCamera();
            });
        }
      }
    }
  };

  useEffect(() => {
    // Auto-stop camera if user navigates away from the context where it was opened
    if (isCameraActive) {
      if (cameraMode === 'chat' && activeTab !== 'chat') {
        stopCamera();
      } else if (cameraMode === 'profile' && (activeTab !== 'settings' && activeTab !== 'profile')) {
        stopCamera();
      }
    }
  }, [activeTab, isCameraActive, cameraMode, stopCamera]);

  const handleUserCommand = async (command: string, imageUrl?: string, mode: 'text' | 'voice' = 'text', visionBase64?: string, uploadedFiles?: { url: string, name: string, type: string }[]) => {
    if (!command.trim() && !imageUrl && (!uploadedFiles || uploadedFiles.length === 0)) return;
    
    setIsProcessing(true);
    const lowerCommand = (command || '').toLowerCase();

    const userMessage = { 
      role: 'user' as const, 
      text: command || '[File Uploaded]', 
      image: imageUrl || null,
      files: uploadedFiles || []
    };
    setHistory(prev => [...prev, userMessage]);

    if (user) {
      addDoc(collection(db, 'users', user.uid, 'history'), {
        ...userMessage,
        createdAt: serverTimestamp()
      });
    }
    
    try {
      const geminiHistory = history.map(h => ({
        role: h.role,
        parts: [{ text: h.text }]
      }));

      // Use visionBase64 if provided, otherwise fallback to imageUrl if it's base64
      const visionData = visionBase64 || (imageUrl?.startsWith('data:') ? imageUrl : undefined);
      const response = await getAssistantResponse(command || 'Take a look at this image.', geminiHistory, visionData);
      
      let cleanResponse = response.replace(/\[ACTION:.*?\]/g, '').replace(/```json[\s\S]*?```/g, '').trim();
      const modelMessage = { role: 'model' as const, text: cleanResponse };
      setHistory(prev => [...prev, modelMessage]);

      if (user) {
        addDoc(collection(db, 'users', user.uid, 'history'), {
          ...modelMessage,
          createdAt: serverTimestamp()
        });
      }
      
      // Only speak if user used voice
      if (mode === 'voice') {
        speak(cleanResponse);
      }

      // 1. Handle JSON actions
      const jsonMatch = response.match(/```json([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          const actions = JSON.parse(jsonMatch[1].trim());
          if (Array.isArray(actions)) {
            setExecutingActions(actions);
            setCurrentExecIndex(0);
          }
        } catch (e) {
          console.error("Failed to parse JSON actions:", e);
        }
      }

      // 2. Handle [ACTION:...] tags (legacy support)
      const actionMatch = response.match(/\[ACTION:(.*?)\|(.*?)\]/);
      if (actionMatch) {
          const [, type, value] = actionMatch;
          const taskId = Math.random().toString(36).substr(2, 9);
          const newTask: any = {
            type: type,
            value: value,
            time: Date.now(),
            createdAt: new Date().toISOString(),
            dueAt: null // Explicitly initialize
          };

          if (user) {
            addDoc(collection(db, 'users', user.uid, 'tasks'), newTask);
          } else {
            setTasks(prev => [{ id: taskId, ...newTask }, ...prev]);
          }

          if (type === 'OPEN_APP') {
            setExecutingActions([{ action: 'OPEN_APP', app_name: value }]);
            setCurrentExecIndex(0);
          }
      }
    } catch (err) {
      console.error("AI Error:", err);
      setError("Neutral link interrupted.");
    } finally {
      setIsProcessing(false);
    }
  };

  const speak = (text: string) => {
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {
        console.warn("Speech cancel failed", e);
      }
      
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
      let voices = window.speechSynthesis.getVoices();
      
      const selectVoice = () => {
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
      };

      if (!voices.length) {
        // Wait for voices to load if list is empty
        window.speechSynthesis.onvoiceschanged = () => {
          voices = window.speechSynthesis.getVoices();
          selectVoice();
          startSpeaking();
          window.speechSynthesis.onvoiceschanged = null;
        };
      } else {
        selectVoice();
        startSpeaking();
      }

      function startSpeaking() {
        utterance.rate = settingsRef.current.voiceSpeed;
        utterance.pitch = settingsRef.current.voicePitch;
        
        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => {
          setIsSpeaking(false);
          if (settingsRef.current.autoListen && !isActuallyListeningRef.current) {
            try { 
              isActuallyListeningRef.current = true;
              recognitionRef.current?.start(); 
            } catch (e) {
              isActuallyListeningRef.current = false;
            }
          }
        };
        utterance.onerror = (e) => {
          console.error("Utterance error", e);
          setIsSpeaking(false);
        };
        
        synthesisRef.current = utterance;
        try {
          window.speechSynthesis.speak(utterance);
        } catch (err) {
          console.error("Speech submission failed", err);
          setIsSpeaking(false);
        }
      }
    }
  };

  const toggleListening = () => {
    if ('vibrate' in navigator && settingsRef.current.hapticFeedback) {
      navigator.vibrate(40);
    }
    
    if (isListening) {
      // If we have text and manually stop, process it
      if (transcript.trim()) {
        handleUserCommand(transcript, undefined, 'voice');
      }
      recognitionRef.current?.stop();
    } else {
      setError(null);
      setTranscript('');
      // Stop ongoing speech before starting listener
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      
      setTimeout(() => {
        try {
          if (recognitionRef.current && !isActuallyListeningRef.current) {
            isActuallyListeningRef.current = true; // Set early to prevent race conditions
            recognitionRef.current.start();
          }
        } catch (err: any) {
          isActuallyListeningRef.current = false;
          console.error("Recognition start failed:", err);
          setIsListening(false);
          const errMsg = err.message || '';
          if (errMsg.toLowerCase().includes('found')) {
            setError("Neural listener is unavailable. Please verify microphone access.");
          }
        }
      }, 300);
    }
  };

  const startHoldToTalk = (e: React.MouseEvent | React.TouchEvent) => {
    if (settings.autoListen) return; // Don't interfere with auto-listen
    e.preventDefault();
    setIsHoldToTalk(true);
    
    if ('vibrate' in navigator && settingsRef.current.hapticFeedback) {
      navigator.vibrate([20, 10, 20]);
    }

    if (!isActuallyListeningRef.current) {
      setError(null);
      setTranscript('');
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      
      try {
        isActuallyListeningRef.current = true;
        recognitionRef.current?.start();
      } catch (err) {
        isActuallyListeningRef.current = false;
        console.error("HTT Start failed:", err);
      }
    }
  };

  const stopHoldToTalk = () => {
    if (!isHoldToTalk) return;
    setIsHoldToTalk(false);

    const finalTranscript = latestTranscriptRef.current.trim();
    if (finalTranscript) {
      handleUserCommand(finalTranscript, undefined, 'voice');
    }
    
    try {
      recognitionRef.current?.stop();
    } catch (err) {
      console.error("HTT Stop failed:", err);
    }
    setTranscript('');
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
        {loading ? (
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
          <div className="flex gap-2">
            <button 
              onClick={() => setActiveTab(activeTab === 'profile' ? 'chat' : 'profile')}
              className={cn(
                "p-3 rounded-2xl border border-white/5 hover:bg-white/5 transition-all active:scale-95 relative",
                activeTab === 'profile' && "bg-white/10 border-white/20"
              )}
            >
              <UserCircle className={cn("w-5 h-5", activeTab === 'profile' && activeText)} />
              {user && <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-green-400 border border-black" />}
            </button>
            <button 
              onClick={() => setActiveTab(activeTab === 'settings' ? 'chat' : 'settings')}
              className={cn(
                "p-3 rounded-2xl border border-white/5 hover:bg-white/5 transition-all active:scale-95",
                activeTab === 'settings' && "bg-white/10 border-white/20"
              )}
            >
              <Settings className={cn("w-5 h-5 transition-transform duration-500", activeTab === 'settings' && "rotate-180")} />
            </button>
          </div>
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
                    {['chat', 'tasks', 'profile'].map((tab) => (
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
                    <div className="flex flex-col items-center justify-center h-full text-center opacity-40">
                      <div className="relative group">
                        <motion.div
                          animate={{ 
                            scale: [1, 1.2, 1],
                            opacity: [0.1, 0.3, 0.1] 
                          }}
                          transition={{ repeat: Infinity, duration: 4, ease: "easeInOut" }}
                          className={cn("absolute inset-0 blur-3xl rounded-full", activeColor)}
                        />
                        <Globe className={cn("w-16 h-16 mb-4 transition-all duration-1000 group-hover:scale-110", activeText)} />
                      </div>
                      <h3 className="text-[11px] uppercase tracking-[0.5em] font-black opacity-30 mt-6">Aura Neural Interface</h3>
                      <p className="text-[9px] uppercase tracking-widest font-bold opacity-10 mt-2">Ready for Neural Input</p>
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
                        {msg.files && msg.files.length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-3">
                            {msg.files.map((file, fidx) => (
                              <a 
                                key={fidx}
                                href={file.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-2 rounded-xl hover:bg-white/10 transition-all group/file-link"
                              >
                                <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center border border-white/10 shrink-0">
                                  {file.type === 'pdf' ? (
                                    <FileText className="w-4 h-4 text-red-400" />
                                  ) : file.type === 'doc' ? (
                                    <FileText className="w-4 h-4 text-blue-400" />
                                  ) : file.type === 'sheet' ? (
                                    <Table className="w-4 h-4 text-green-400" />
                                  ) : file.type === 'slide' ? (
                                    <Presentation className="w-4 h-4 text-orange-400" />
                                  ) : file.type === 'archive' ? (
                                    <FileArchive className="w-4 h-4 text-yellow-500" />
                                  ) : (
                                    <LucideFile className="w-4 h-4 text-gray-400" />
                                  )}
                                </div>
                                <div className="flex flex-col min-w-0 max-w-[120px]">
                                  <span className="text-[10px] font-bold text-white/90 truncate">{file.name}</span>
                                  <span className="text-[8px] text-white/40 uppercase tracking-widest font-black">Download</span>
                                </div>
                              </a>
                            ))}
                          </div>
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
                      const tasksSnap = await getDocs(collection(db, 'users', user.uid, 'tasks'));
                      tasksSnap.forEach(d => deleteDoc(d.ref));
                    } else {
                      setTasks([]);
                    }
                  }} className="text-[10px] opacity-40 hover:opacity-100 hover:text-red-400 flex items-center gap-1 transition-colors">
                    <Trash2 className="w-3 h-3" /> Clear Nodes
                  </button>
                </div>

                {/* Quick Add Node */}
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = (e.currentTarget.elements.namedItem('nodeValue') as HTMLInputElement);
                    if (input.value.trim()) {
                      const taskData = { 
                        id: crypto.randomUUID(),
                        type: 'MANUAL_ENTRY', 
                        value: input.value.trim(), 
                        time: 0, 
                        createdAt: new Date().toISOString()
                      };
                      setTasks(prev => [taskData, ...prev]);
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
                            onClick={() => {
                              playCompleteSound();
                              setCompletingTasks(prev => new Set([...prev, task.id]));
                              // Delay deletion for animation
                              setTimeout(() => {
                                if (user) {
                                  deleteDoc(doc(db, 'users', user.uid, 'tasks', task.id));
                                } else {
                                  setTasks(prev => prev.filter(t => t.id !== task.id));
                                }
                                setCompletingTasks(prev => {
                                  const next = new Set(prev);
                                  next.delete(task.id);
                                  return next;
                                });
                              }, 600);
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
                            onClick={() => {
                              setTasks(prev => prev.filter(t => t.id !== task.id));
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

            {activeTab === 'profile' && (
              <UserProfile 
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
                  <h2 className={cn("text-xs uppercase tracking-[0.3em] font-black", activeText)}>Settings</h2>
                  <button 
                    onClick={() => setActiveTab('chat')} 
                    className="p-2 rounded-full hover:bg-white/10 text-white/40 hover:text-white transition-all active:scale-90"
                    title="Exit Settings"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="space-y-6">
                  {/* User Profile */}
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                    className="space-y-4"
                  >
                    {isCameraActive && cameraMode === 'profile' ? (
                      <div className="relative w-full aspect-square max-h-80 rounded-3xl overflow-hidden bg-black/80 border-2 border-white/10 flex flex-col items-center justify-center shadow-2xl">
                        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent pointer-events-none" />
                        
                        {/* Zoom Control Overlay */}
                        {hasZoomSupport && (
                          <div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-3 bg-black/40 backdrop-blur-md p-2 rounded-full border border-white/10">
                            <span className="text-[8px] font-black text-white/40">Z</span>
                            <div className="h-32 w-1 relative bg-white/10 rounded-full overflow-hidden">
                              <input 
                                type="range"
                                min={cameraCapabilities?.zoom?.min || 1}
                                max={cameraCapabilities?.zoom?.max || 3}
                                step="0.1"
                                value={cameraZoom}
                                onChange={(e) => applyZoom(parseFloat(e.target.value))}
                                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 -rotate-90 bg-transparent appearance-none cursor-pointer accent-cyan-400"
                              />
                            </div>
                            <span className="text-[8px] font-mono text-white/40">{cameraZoom.toFixed(1)}x</span>
                          </div>
                        )}

                        <div className="absolute inset-x-0 bottom-0 p-4 pb-6 flex justify-center items-center gap-6">
                          <button onClick={stopCamera} className="p-3 bg-white/10 backdrop-blur-md rounded-full text-white/70 hover:text-white hover:bg-white/20 transition-all border border-white/5">
                            <X className="w-5 h-5" />
                          </button>
                          <button 
                            onClick={capturePhoto} 
                            className={cn("p-4 rounded-full shadow-2xl transition-all active:scale-95", activeColor)}
                          >
                            <Camera className="w-7 h-7 text-white" />
                          </button>
                        </div>
                      </div>
                    ) : (
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                      <div className="relative group shrink-0">
                        <div className={cn("w-20 h-20 rounded-full overflow-hidden bg-white/5 flex items-center justify-center border-2 transition-all duration-500", activeBorder)}>
                          {settings.profilePic ? (
                            <img src={settings.profilePic} className="w-full h-full object-cover" alt="Profile" />
                          ) : (
                            <UserCircle className="w-10 h-10 opacity-30" />
                          )}
                        </div>
                        <button 
                          onClick={() => startCamera('profile')}
                          className={cn("absolute -bottom-1 -right-1 p-2 rounded-full shadow-lg transition-all active:scale-95", activeColor)}
                        >
                          <Camera className="w-3.5 h-3.5 text-white" />
                        </button>
                      </div>
                      <div className="flex-1 w-full space-y-3">
                        <label className="text-[10px] uppercase tracking-widest font-black opacity-30">Neural Identity</label>
                        <div className="flex items-center gap-2">
                          <input 
                            type="text" 
                            value={settings.userName}
                            onChange={(e) => setSettings({ ...settings, userName: e.target.value })}
                            className="flex-1 bg-white/5 border border-white/5 rounded-2xl px-5 py-3 text-sm focus:outline-none focus:border-white/20 transition-all font-bold tracking-tight"
                            placeholder="Input Name"
                          />
                        </div>
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
                      onClick={async () => {
                        if (confirm('Clear entire chat history?')) {
                          if (user) {
                            try {
                              // Delete from Firestore
                              const historySnap = await getDocs(collection(db, 'users', user.uid, 'history'));
                              historySnap.forEach(d => deleteDoc(d.ref));
                              
                              const tasksSnap = await getDocs(collection(db, 'users', user.uid, 'tasks'));
                              tasksSnap.forEach(d => deleteDoc(d.ref));
                            } catch (e) {
                              console.error("Failed to clear cloud sync:", e);
                            }
                          } else {
                            setHistory([]);
                            setTasks([]);
                          }
                          setActiveTab('chat');
                        }
                      }}
                      className="w-full mt-4 py-5 rounded-2xl bg-red-500/20 border border-red-500/30 text-red-500 text-xs uppercase tracking-[0.2em] font-black hover:bg-red-500/30 transition-all active:scale-95 flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(239,68,68,0.2)]"
                    >
                      <Trash2 className="w-4 h-4" /> Clear Chat History
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Enhanced Camera Overlay */}
        <AnimatePresence>
          {isCameraActive && cameraMode === 'chat' && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-sm aspect-square sm:aspect-video rounded-3xl overflow-hidden bg-black border-2 border-white/10 z-[300] shadow-[0_0_80px_rgba(0,0,0,0.9)]"
            >
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
              
              {/* Camera UI Elements */}
              <div className="absolute inset-0 border border-white/5 pointer-events-none">
                 <div className="absolute top-4 left-4 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />
                    <span className="text-[10px] font-black uppercase tracking-[0.3em] text-white/60">Rec Interface</span>
                 </div>
                 {/* Viewfinder Corners */}
                 <div className="absolute top-6 left-6 w-4 h-4 border-t border-l border-white/30" />
                 <div className="absolute top-6 right-6 w-4 h-4 border-t border-r border-white/30" />
                 <div className="absolute bottom-6 left-6 w-4 h-4 border-b border-l border-white/30" />
                 <div className="absolute bottom-6 right-6 w-4 h-4 border-b border-r border-white/30" />
              </div>

              {/* Zoom and Focus Controls */}
              <div className="absolute right-6 top-1/2 -translate-y-1/2 flex flex-col items-center gap-6 bg-black/40 backdrop-blur-2xl p-3 rounded-full border border-white/10">
                 <button 
                  onClick={() => {
                    const track = streamRef.current?.getVideoTracks()[0];
                    // @ts-ignore
                    track?.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
                  }}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors text-cyan-400"
                  title="Auto Focus"
                 >
                    <Search className="w-4 h-4" />
                 </button>
                 
                 {hasZoomSupport && (
                   <div className="flex flex-col items-center gap-4">
                      <Zap className="w-3 h-3 text-white/40" />
                      <div className="h-32 w-1.5 relative bg-white/5 rounded-full">
                          <input 
                            type="range"
                            min={cameraCapabilities?.zoom?.min || 1}
                            max={cameraCapabilities?.zoom?.max || 3}
                            step="0.1"
                            value={cameraZoom}
                            onChange={(e) => applyZoom(parseFloat(e.target.value))}
                            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 -rotate-90 bg-transparent appearance-none cursor-pointer accent-cyan-400"
                          />
                      </div>
                      <span className="text-[8px] font-mono text-white/60">{cameraZoom.toFixed(1)}x</span>
                   </div>
                 )}
              </div>

              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />
              <div className="absolute inset-x-0 bottom-0 p-8 flex justify-center items-center gap-10">
                <button 
                  onClick={stopCamera} 
                  className="p-4 bg-white/5 backdrop-blur-xl rounded-full text-white/40 hover:text-white hover:bg-white/10 transition-all active:scale-95 border border-white/10"
                >
                  <X className="w-6 h-6" />
                </button>
                <div className="relative">
                  <motion.div 
                    animate={{ scale: [1, 1.1, 1] }} 
                    transition={{ repeat: Infinity, duration: 2 }}
                    className={cn("absolute -inset-4 opacity-20 blur-xl rounded-full", activeColor)}
                  />
                  <button 
                    onClick={capturePhoto} 
                    className={cn("relative p-6 rounded-full shadow-2xl transition-all active:scale-90 border border-white/20", activeColor)}
                  >
                    <Camera className="w-10 h-10 text-white" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Global Controls - Gemini Like Redesign */}
        <div className="fixed bottom-0 left-0 w-full px-4 pb-4 sm:pb-8 pt-4 bg-gradient-to-t from-black via-black/90 to-transparent pointer-events-none z-[100]">
          <div className="max-w-xl mx-auto pointer-events-auto">
            {/* Action/Error Notification Area */}
            <div className="flex flex-col gap-2 mb-3">
              <AnimatePresence>
                {isSpeaking && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="flex justify-center"
                  >
                    <button 
                      onClick={stopSpeaking}
                      className="px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-full text-[10px] text-red-500 font-black uppercase tracking-widest flex items-center gap-2 hover:bg-red-500/20 transition-all active:scale-95"
                    >
                      <VolumeX className="w-3 h-3" /> Stop Speech
                    </button>
                  </motion.div>
                )}
                {error && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="bg-red-500/10 border border-red-500/20 px-4 py-3 rounded-2xl text-[10px] text-red-400 font-mono tracking-wider flex justify-between items-center backdrop-blur-xl"
                  >
                    <span>{error}</span>
                    <button onClick={() => setError(null)} className="opacity-60 hover:opacity-100">DISMISS</button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Main Chat Box Container */}
            <div className="relative group">
              {/* File Previews */}
              <AnimatePresence>
                {selectedFiles.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 10 }}
                    className="absolute bottom-full left-0 right-0 mb-4 flex gap-2 p-2 overflow-x-auto no-scrollbar scroll-smooth"
                  >
                    <div className="flex gap-2">
                      {selectedFiles.map((f) => (
                        <motion.div 
                          key={f.id}
                          layout
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          className="relative group/file bg-black/40 backdrop-blur-2xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex items-center p-2 gap-3 min-w-[140px]"
                        >
                          <div className="w-12 h-12 rounded-xl shrink-0 overflow-hidden flex items-center justify-center bg-white/5 border border-white/10">
                            {f.type === 'image' ? (
                              <img src={f.preview} alt="preview" className="w-full h-full object-cover" />
                            ) : f.type === 'pdf' ? (
                              <FileText className="w-6 h-6 text-red-400" />
                            ) : f.type === 'doc' ? (
                              <FileText className="w-6 h-6 text-blue-400" />
                            ) : f.type === 'sheet' ? (
                              <Table className="w-6 h-6 text-green-400" />
                            ) : f.type === 'slide' ? (
                              <Presentation className="w-6 h-6 text-orange-400" />
                            ) : f.type === 'archive' ? (
                              <FileArchive className="w-6 h-6 text-yellow-500" />
                            ) : (
                              <LucideFile className="w-6 h-6 text-gray-400" />
                            )}
                          </div>
                          <div className="flex flex-col flex-1 min-w-0 pr-10">
                              <div className="flex flex-col gap-0.5">
                                 <span className="text-[10px] font-bold text-white/90 truncate">{f.file.name}</span>
                                 <span className="text-[8px] text-white/40 uppercase tracking-widest font-black">
                                   {f.type === 'pdf' ? 'PDF Document' : 
                                    f.type === 'image' ? 'Image' : 
                                    f.type === 'doc' ? 'Word/Text' : 
                                    f.type === 'sheet' ? 'Spreadsheet' : 
                                    f.type === 'slide' ? 'Presentation' : 
                                    f.type === 'archive' ? 'Archive' : 'File'}
                                 </span>
                              </div>
                              <input 
                                type="text"
                                placeholder="Add a caption..."
                                value={f.caption || ''}
                                onChange={(e) => updateFileCaption(f.id, e.target.value)}
                                className="mt-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-[10px] text-white placeholder:text-white/30 focus:outline-none focus:border-cyan-500/50 transition-all"
                              />
                          </div>
                          <button 
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFile(f.id);
                            }}
                            className="absolute top-2 right-2 bg-red-500/80 hover:bg-red-500 text-white rounded-full p-1 opacity-0 group-hover/file:opacity-100 transition-all duration-300 transform scale-90"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Tool Menu Extension */}
              <AnimatePresence>
                {showTools && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute bottom-full left-0 mb-4 bg-[#1a1a1c]/95 backdrop-blur-2xl border border-white/10 rounded-2xl p-2 flex flex-col gap-1 min-w-[140px] shadow-2xl z-[110]"
                  >
                    <button 
                      onClick={() => {
                        startCamera();
                        setShowTools(false);
                      }}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 rounded-xl transition-all text-white/70 hover:text-white"
                    >
                      <Camera className="w-4 h-4 text-cyan-400" />
                      <span className="text-[10px] font-black uppercase tracking-widest">Camera</span>
                    </button>
                    <button 
                      onClick={() => {
                        fileInputRef.current?.click();
                        setShowTools(false);
                      }}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 rounded-xl transition-all text-white/70 hover:text-white"
                    >
                      <Paperclip className="w-4 h-4 text-purple-400" />
                      <span className="text-[10px] font-black uppercase tracking-widest">Post File</span>
                    </button>
                    <input 
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileSelect}
                      multiple
                      accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,text/plain"
                      className="hidden"
                    />
                    <div className="h-[1px] bg-white/5 my-1" />
                    <button 
                      onClick={() => {
                        setActiveTab('tasks');
                        setShowTools(false);
                      }}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 rounded-xl transition-all text-white/70 hover:text-white"
                    >
                      <Zap className="w-4 h-4 text-yellow-400" />
                      <span className="text-[10px] font-black uppercase tracking-widest">Tasks</span>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Chat Input Bar */}
              <form 
                onSubmit={handleTextInput}
                className="flex items-end gap-2 bg-[#1a1a1c]/80 backdrop-blur-3xl border border-white/10 rounded-[32px] p-2 pl-3 focus-within:border-white/20 transition-all shadow-2xl relative z-[100]"
              >
                {isUploading && (
                  <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-cyan-500/20 backdrop-blur-xl border border-cyan-500/30 px-4 py-1.5 rounded-full flex items-center gap-2 animate-pulse">
                    <Activity className="w-3 h-3 text-cyan-400 animate-spin" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-cyan-400">Syncing to Cloud...</span>
                  </div>
                )}
                <div className="relative group">
                  <button 
                    type="button"
                    onClick={() => setShowTools(!showTools)}
                    className={cn(
                      "p-3.5 rounded-full transition-all active:scale-90 flex items-center justify-center mb-0.5 relative overflow-hidden",
                      showTools ? "bg-white/10 text-white" : "text-white/40 hover:text-white hover:bg-white/5"
                    )}
                  >
                    <Plus className={cn("w-5 h-5 transition-transform duration-500", showTools && "rotate-45")} />
                    <motion.div 
                      className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"
                      initial={false}
                    />
                  </button>
                </div>

                <textarea 
                  rows={1}
                  value={inputText}
                  onChange={(e) => {
                    setInputText(e.target.value);
                    setIsUserTyping(true);
                    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
                    typingTimeoutRef.current = setTimeout(() => setIsUserTyping(false), 1500);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleTextInput(e as any);
                    }
                  }}
                  placeholder="Ask Aura..."
                  className="flex-1 bg-transparent border-none px-2 py-3.5 text-[15px] focus:outline-none placeholder:text-white/20 resize-none min-h-[48px] max-h-32 text-white/90 scroll-smooth no-scrollbar"
                />

                <div className="flex items-center gap-1 mb-0.5 mr-0.5">
                  <AnimatePresence mode="wait">
                    {inputText.trim() ? (
                      <motion.button
                        key="send"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        type="submit"
                        disabled={isProcessing}
                        className={cn(
                          "p-3 rounded-full transition-all active:scale-95 disabled:opacity-50",
                          activeColor, "text-white shadow-lg"
                        )}
                      >
                        <Send className="w-5 h-5" />
                      </motion.button>
                    ) : (
                      <motion.button
                        key="voice"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        whileTap={{ scale: 0.9 }}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          startHoldToTalk(e);
                        }}
                        onMouseUp={(e) => {
                          e.preventDefault();
                          stopHoldToTalk();
                        }}
                        onMouseLeave={stopHoldToTalk}
                        onTouchStart={(e) => {
                          e.preventDefault();
                          startHoldToTalk(e);
                        }}
                        onTouchEnd={(e) => {
                          e.preventDefault();
                          stopHoldToTalk();
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          if (!isHoldToTalk) toggleListening();
                        }}
                        className={cn(
                          "relative p-5 rounded-full transition-all duration-500 flex items-center justify-center group overflow-hidden shadow-2xl border border-transparent",
                          isListening 
                            ? "bg-red-500 scale-125 shadow-red-500/50 rotate-[360deg] border-red-400/50" 
                            : cn("bg-white/5 hover:bg-white/10 text-white/40 hover:text-white", activeBorder)
                        )}
                      >
                        {/* Dynamic Waveform Rings */}
                        <AnimatePresence>
                          {isListening && (
                            <>
                              <motion.div 
                                initial={{ scale: 0.8, opacity: 0.5 }}
                                animate={{ scale: 3.5, opacity: 0 }}
                                transition={{ repeat: Infinity, duration: 2, ease: "easeOut" }}
                                className="absolute inset-0 bg-red-500/30 rounded-full"
                              />
                              <motion.div 
                                initial={{ scale: 0.8, opacity: 0.5 }}
                                animate={{ scale: 2.5, opacity: 0 }}
                                transition={{ repeat: Infinity, duration: 2, delay: 0.7, ease: "easeOut" }}
                                className="absolute inset-0 bg-red-400/20 rounded-full"
                              />
                              <motion.div 
                                initial={{ scale: 1 }}
                                animate={{ scale: [1, 1.1, 1] }}
                                transition={{ repeat: Infinity, duration: 0.8 }}
                                className="absolute inset-0 bg-red-600/10 rounded-full"
                              />
                            </>
                          )}
                        </AnimatePresence>
                        
                        <div className="relative z-10">
                          {isListening ? (
                            <div className="flex items-center justify-center">
                               <MicOff className="w-7 h-7 text-white" />
                               <motion.div 
                                 animate={{ opacity: [0.3, 1, 0.3] }}
                                 transition={{ repeat: Infinity, duration: 1 }}
                                 className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-white shadow-lg"
                               />
                            </div>
                          ) : (
                            <Mic className="w-6 h-6 group-hover:scale-110 transition-transform" />
                          )}
                        </div>

                        {/* Theme-based reactive glow */}
                        {!isListening && (
                          <div className={cn("absolute inset-0 opacity-0 group-hover:opacity-20 transition-opacity blur-2xl rounded-full", activeColor)} />
                        )}
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </form>
            </div>
            
            <AnimatePresence>
              {/* Visual feedback removed per user request */}
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
