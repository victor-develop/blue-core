import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  LayoutGrid, 
  MessageSquare, 
  Users, 
  Plus, 
  Play, 
  Square, 
  Settings, 
  ChevronRight, 
  Send, 
  Activity, 
  Terminal, 
  Clock, 
  Layers, 
  Zap,
  Box,
  Cpu,
  ShieldAlert,
  CheckCircle2,
  AlertCircle,
  Loader2,
  MoreHorizontal,
  FolderOpen
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types & Constants ---

type ViewMode = 'sessions' | 'rooms' | 'templates' | 'session-detail' | 'room-detail';

interface Model {
  id: string;
  label: string;
}

interface Session {
  id: string;
  title: string;
  model: string;
  cwd: string;
  persona: string;
  status: 'idle' | 'working' | 'error' | 'missing';
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface Message {
  id: string;
  type: 'user' | 'agent';
  author: string;
  model: string;
  content: string;
  createdAt: string;
}

interface ProcessEvent {
  id: string;
  type: 'process';
  family: string;
  phase: 'started' | 'completed' | 'failed' | 'updated';
  author: string;
  model: string;
  content: string;
  createdAt: string;
  process: any;
}

interface Room {
  id: string;
  title: string;
  instruction: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  mode: string;
  autoplay: {
    active: boolean;
    turnCount: number;
    maxTurns: number;
  };
  members: Array<{
    sessionId: string;
    displayName: string;
    model: string;
    cwd: string;
    persona: string;
    status: string;
  }>;
}

interface RoomEvent {
  id: string;
  type: 'user' | 'agent' | 'system' | 'process';
  author: string;
  sessionId?: string;
  model?: string;
  content: string;
  createdAt: string;
  process?: any;
}

interface Template {
  id: string;
  title: string;
  description: string;
}

// --- Components ---

const StatusBadge = ({ status }: { status: string }) => {
  const getStatusClass = () => {
    switch (status) {
      case 'working': return 'status-working';
      case 'error': return 'status-error';
      default: return 'status-idle';
    }
  };
  return (
    <div className="flex items-center gap-2">
      <span className={`status-dot ${getStatusClass()}`} />
      <span className="text-[11px] font-medium uppercase tracking-wider text-secondary">{status}</span>
    </div>
  );
};

const ProcessIcon = ({ family }: { family: string }) => {
  switch (family) {
    case 'tool': return <Terminal size={14} className="text-blue-500" />;
    case 'reasoning': return <Zap size={14} className="text-amber-500" />;
    case 'file': return <FolderOpen size={14} className="text-emerald-500" />;
    case 'error': return <ShieldAlert size={14} className="text-red-500" />;
    case 'task': return <CheckCircle2 size={14} className="text-indigo-500" />;
    default: return <Activity size={14} className="text-slate-400" />;
  }
};

const TimelineItem = ({ item }: { item: Message | ProcessEvent | RoomEvent, key?: string }) => {
  const isProcess = item.type === 'process';
  const isUser = item.type === 'user';
  const isAgent = item.type === 'agent';
  const isSystem = item.type === 'system';

  if (isProcess) {
    const p = item as ProcessEvent;
    return (
      <div className="process-event">
        <div className="process-icon">
          <ProcessIcon family={p.family} />
        </div>
        <div className="process-content">
          <div className="process-header">
            <span className="process-title">{p.family.toUpperCase()} • {p.phase.toUpperCase()}</span>
            <span className="process-time">{new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div className="process-body">{p.content}</div>
        </div>
      </div>
    );
  }

  if (isSystem) {
    return (
      <div className="flex justify-center py-2">
        <div className="px-4 py-1 rounded-full bg-slate-100 text-[11px] font-medium text-slate-500 uppercase tracking-widest border border-slate-200">
          {item.content}
        </div>
      </div>
    );
  }

  return (
    <div className={`timeline-item ${isUser ? 'message-user' : 'message-agent'}`}>
      <div className="message-meta">
        <span className="message-author">{item.author}</span>
        <span>•</span>
        <span>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div className="message-bubble">
        {item.content}
      </div>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const [view, setView] = useState<ViewMode>('sessions');
  const [models, setModels] = useState<Model[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [config, setConfig] = useState<{ defaultCwd: string } | null>(null);
  const [status, setStatus] = useState('Ready.');
  const [sessionActivity, setSessionActivity] = useState('');
  const [roomActivity, setRoomActivity] = useState('');
  
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  
  const [sessionDetail, setSessionDetail] = useState<{ session: Session, messages: Message[], processEvents: ProcessEvent[] } | null>(null);
  const [roomDetail, setRoomDetail] = useState<{ room: Room, events: RoomEvent[] } | null>(null);
  
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [isLaunchingTemplate, setIsLaunchingTemplate] = useState(false);
  
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);

  // --- API Helpers ---

  const fetchData = async () => {
    try {
      const [mRes, sRes, rRes, tRes, cRes] = await Promise.all([
        fetch('/api/models'),
        fetch('/api/sessions'),
        fetch('/api/rooms'),
        fetch('/api/templates'),
        fetch('/api/config')
      ]);
      
      const mData = await mRes.json();
      const sData = await sRes.json();
      const rData = await rRes.json();
      const tData = await tRes.json();
      const cData = await cRes.json();
      
      setModels(mData.models);
      setSessions(sData.sessions);
      setRooms(rData.rooms);
      setTemplates(tData.templates);
      setConfig(cData);
      setStatus('Workspace loaded.');
    } catch (err) {
      console.error('Failed to fetch initial data', err);
      setStatus('Failed to fetch initial data.');
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    return () => {
      sseRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (timelineEndRef.current) {
      timelineEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [sessionDetail, roomDetail]);

  // --- SSE Lifecycle ---

  const setupSSE = (type: 'session' | 'room', id: string) => {
    if (sseRef.current) sseRef.current.close();
    
    const url = `/api/${type}s/${id}/stream`;
    const sse = new EventSource(url);
    sseRef.current = sse;

    if (type === 'session') {
      sse.addEventListener('message', (e) => {
        const data = JSON.parse(e.data);
        setSessions(prev => prev.map(session => session.id === data.session?.id ? data.session : session));
        setSessionDetail(prev => {
          if (!prev || prev.session.id !== id) return prev;
          return {
            ...prev,
            session: data.session,
            messages: [...prev.messages, data.message]
          };
        });
        if (data.message?.type === 'agent') {
          setSessionActivity('');
        }
      });

      sse.addEventListener('process', (e) => {
        const data = JSON.parse(e.data);
        setSessions(prev => prev.map(session => session.id === data.session?.id ? data.session : session));
        setSessionDetail(prev => {
          if (!prev || prev.session.id !== id) return prev;
          return {
            ...prev,
            session: data.session,
            processEvents: [...prev.processEvents, data.event]
          };
        });
        setSessionActivity(data.event?.content || 'Agent is working.');
      });
    } else {
      sse.addEventListener('message', (e) => {
        const data = JSON.parse(e.data);
        setRooms(prev => prev.map(room => room.id === data.room?.id ? data.room : room));
        setRoomDetail(prev => {
          if (!prev || prev.room.id !== id) return prev;
          return {
            ...prev,
            room: data.room,
            events: [...prev.events, data.event]
          };
        });
        if (data.event?.type === 'process') {
          setRoomActivity(data.event.content || 'Agent is working.');
        } else if (data.event?.type === 'agent' || data.event?.type === 'system') {
          setRoomActivity('');
        }
      });

      sse.addEventListener('turn.started', (e) => {
        const data = JSON.parse(e.data);
        setRooms(prev => prev.map(room => room.id === data.room?.id ? data.room : room));
        setRoomDetail(prev => {
          if (!prev || prev.room.id !== id) return prev;
          return {
            ...prev,
            room: data.room
          };
        });
        const member = data.room?.members?.[data.nextSpeakerIndex];
        setRoomActivity(member ? `${member.displayName} is taking turn ${Number(data.turnCount || 0) + 1}.` : 'An agent is working.');
      });
    }

    sse.onerror = () => {
      setStatus(`${type === 'session' ? 'Session' : 'Room'} stream disconnected.`);
    };

    return () => sse.close();
  };

  // --- Navigation Handlers ---

  const openSession = async (id: string) => {
    try {
      const res = await fetch(`/api/sessions/${id}`);
      const data = await res.json();
      setSessionDetail(data);
      setActiveSessionId(id);
      setActiveRoomId(null);
      setRoomActivity('');
      setView('session-detail');
      setStatus(`Opened session ${data.session?.title || ''}`.trim());
      setupSSE('session', id);
    } catch (err) {
      console.error('Failed to load session', err);
      setStatus('Failed to load session.');
    }
  };

  const openRoom = async (id: string) => {
    try {
      const res = await fetch(`/api/rooms/${id}`);
      const data = await res.json();
      setRoomDetail(data);
      setActiveRoomId(id);
      setActiveSessionId(null);
      setSessionActivity('');
      setView('room-detail');
      setStatus(`Opened room ${data.room?.title || ''}`.trim());
      setupSSE('room', id);
    } catch (err) {
      console.error('Failed to load room', err);
      setStatus('Failed to load room.');
    }
  };

  // --- Action Handlers ---

  const handleSendMessage = async () => {
    if (!inputText.trim() || isSending) return;
    setIsSending(true);
    
    try {
      if (view === 'session-detail' && activeSessionId) {
        setSessionActivity('Agent is working.');
        await fetch(`/api/sessions/${activeSessionId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: inputText, author: 'You' })
        });
      } else if (view === 'room-detail' && activeRoomId) {
        await fetch(`/api/rooms/${activeRoomId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: inputText, author: 'You' })
        });
      }
      setInputText('');
    } catch (err) {
      console.error('Failed to send message', err);
      setStatus('Failed to send message.');
    } finally {
      setIsSending(false);
    }
  };

  const toggleAutoplay = async () => {
    if (!roomDetail) return;
    const isActive = roomDetail.room.autoplay.active;
    const endpoint = `/api/rooms/${roomDetail.room.id}/autoplay/${isActive ? 'stop' : 'start'}`;
    
    try {
      const res = await fetch(endpoint, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isActive ? undefined : JSON.stringify({ seedMessage: "" })
      });
      const data = await res.json();
      setRoomDetail(prev => prev ? { ...prev, room: data.room } : null);
      setRooms(prev => prev.map(room => room.id === data.room?.id ? data.room : room));
    } catch (err) {
      console.error('Failed to toggle autoplay', err);
      setStatus('Failed to toggle autoplay.');
    }
  };

  const stopAllRooms = async () => {
    try {
      const res = await fetch('/api/rooms/autoplay/stop-all', { method: 'POST' });
      const data = await res.json();
      setRooms(data.rooms);
      setStatus(`Stopped ${data.stopped?.length || 0} room(s).`);
    } catch (err) {
      console.error('Failed to stop all rooms', err);
      setStatus('Failed to stop all rooms.');
    }
  };

  const handleCreateTemplate = async (templateId: string) => {
    setIsLaunchingTemplate(true);
    try {
      const res = await fetch(`/api/templates/${templateId}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: config?.defaultCwd || undefined })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create template room');
      }
      setSessions(prev => [...data.sessions, ...prev.filter(session => !data.sessions.some((entry: Session) => entry.id === session.id))]);
      setRooms(prev => [data.room, ...prev.filter(room => room.id !== data.room.id)]);
      await openRoom(data.room.id);
      setStatus(`Launched template ${templateId}.`);
    } catch (err) {
      console.error('Failed to create template room', err);
      setStatus('Failed to create template room.');
    } finally {
      setIsLaunchingTemplate(false);
    }
  };

  // --- Merged Timeline ---

  const mergedSessionTimeline = useMemo(() => {
    if (!sessionDetail) return [];
    const combined = [...sessionDetail.messages, ...sessionDetail.processEvents];
    return combined.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [sessionDetail]);

  // --- Creation Forms ---

  const CreateSessionModal = () => {
    const [formData, setFormData] = useState({
      title: '',
      model: models[0]?.id || 'codex',
      cwd: config?.defaultCwd || '',
      persona: ''
    });

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      try {
        const res = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });
        const data = await res.json();
        setSessions(prev => [data.session, ...prev]);
        setIsCreatingSession(false);
        openSession(data.session.id);
      } catch (err) {
        console.error('Failed to create session', err);
      }
    };

    return (
      <div className="modal-overlay" onClick={() => setIsCreatingSession(false)}>
        <motion.div 
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="modal-content" 
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-500">
              <Plus size={24} />
            </div>
            <h2 className="text-xl font-semibold">New Session</h2>
          </div>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Title</label>
              <input 
                className="form-input" 
                placeholder="Session name" 
                value={formData.title}
                onChange={e => setFormData({...formData, title: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Model</label>
              <select 
                className="form-select"
                value={formData.model}
                onChange={e => setFormData({...formData, model: e.target.value})}
              >
                {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Working Directory</label>
              <input 
                className="form-input" 
                value={formData.cwd}
                onChange={e => setFormData({...formData, cwd: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Persona (System Instruction)</label>
              <textarea 
                className="form-textarea h-24" 
                placeholder="Describe the agent's role..."
                value={formData.persona}
                onChange={e => setFormData({...formData, persona: e.target.value})}
              />
            </div>
            <button type="submit" className="btn-primary">Create Session</button>
            <button type="button" className="btn-secondary" onClick={() => setIsCreatingSession(false)}>Cancel</button>
          </form>
        </motion.div>
      </div>
    );
  };

  const CreateRoomModal = () => {
    const [formData, setFormData] = useState({
      title: '',
      instruction: '',
      sessionIds: [] as string[]
    });

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (formData.sessionIds.length === 0) return;
      try {
        const res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData)
        });
        const data = await res.json();
        setRooms(prev => [data.room, ...prev]);
        setIsCreatingRoom(false);
        openRoom(data.room.id);
      } catch (err) {
        console.error('Failed to create room', err);
      }
    };

    const toggleSession = (id: string) => {
      setFormData(prev => ({
        ...prev,
        sessionIds: prev.sessionIds.includes(id) 
          ? prev.sessionIds.filter(sid => sid !== id)
          : [...prev.sessionIds, id]
      }));
    };

    return (
      <div className="modal-overlay" onClick={() => setIsCreatingRoom(false)}>
        <motion.div 
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="modal-content" 
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-500">
              <Users size={24} />
            </div>
            <h2 className="text-xl font-semibold">New Room</h2>
          </div>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Room Title</label>
              <input 
                className="form-input" 
                placeholder="Collaborative workspace name" 
                value={formData.title}
                onChange={e => setFormData({...formData, title: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Shared Instruction</label>
              <textarea 
                className="form-textarea h-20" 
                placeholder="What should the agents achieve together?"
                value={formData.instruction}
                onChange={e => setFormData({...formData, instruction: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Select Sessions (Members)</label>
              <div className="max-h-40 overflow-y-auto border border-border rounded-lg bg-input p-2">
                {sessions.map(s => (
                  <div 
                    key={s.id} 
                    className={`flex items-center justify-between p-2 rounded-md cursor-pointer mb-1 transition-colors ${formData.sessionIds.includes(s.id) ? 'bg-blue-500 text-white' : 'hover:bg-black/5'}`}
                    onClick={() => toggleSession(s.id)}
                  >
                    <span className="text-sm font-medium">{s.title}</span>
                    <span className="text-[10px] opacity-70">{s.model}</span>
                  </div>
                ))}
              </div>
            </div>
            <button type="submit" className="btn-primary">Launch Room</button>
            <button type="button" className="btn-secondary" onClick={() => setIsCreatingRoom(false)}>Cancel</button>
          </form>
        </motion.div>
      </div>
    );
  };

  // --- Render Helpers ---

  const renderSidebar = () => (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <Box size={16} />
        </div>
        <div>
          <span className="sidebar-title">Blue Core</span>
          <div className="text-[11px] text-secondary mt-1">Local multi-agent control room</div>
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-label">Workspace</div>
        <div className={`nav-item ${view === 'sessions' ? 'active' : ''}`} onClick={() => setView('sessions')}>
          <MessageSquare size={18} className="nav-item-icon" />
          <span>Sessions</span>
        </div>
        <div className={`nav-item ${view === 'rooms' ? 'active' : ''}`} onClick={() => setView('rooms')}>
          <Users size={18} className="nav-item-icon" />
          <span>Rooms</span>
        </div>
        <div className={`nav-item ${view === 'templates' ? 'active' : ''}`} onClick={() => setView('templates')}>
          <Layers size={18} className="nav-item-icon" />
          <span>Templates</span>
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-label">Actions</div>
        <div className="nav-item" onClick={() => setIsCreatingSession(true)}>
          <Plus size={18} className="nav-item-icon" />
          <span>New Session</span>
        </div>
        <div className="nav-item" onClick={() => setIsCreatingRoom(true)}>
          <Plus size={18} className="nav-item-icon" />
          <span>New Room</span>
        </div>
        <div className="nav-item text-red-500 hover:bg-red-50" onClick={stopAllRooms}>
          <Square size={18} className="nav-item-icon text-red-400" />
          <span>Stop All Rooms</span>
        </div>
      </div>

      <div className="mt-auto pt-6 border-t border-border">
        <div className="px-3 pb-3 text-[12px] text-secondary leading-relaxed">{status}</div>
        <div className="nav-item">
          <Settings size={18} className="nav-item-icon" />
          <span>Settings</span>
        </div>
      </div>
    </div>
  );

  const renderSessions = () => (
    <div className="main-content">
      <div className="content-header">
        <h1 className="header-title">Sessions</h1>
        <div className="header-actions">
          <button className="btn-primary !w-auto !py-2 !px-4 flex items-center gap-2" onClick={() => setIsCreatingSession(true)}>
            <Plus size={16} /> New Session
          </button>
        </div>
      </div>
      <div className="card-grid">
        {sessions.map(s => (
          <div key={s.id} className="premium-card" onClick={() => openSession(s.id)}>
            <div className="card-header">
              <h3 className="card-title">{s.title}</h3>
              <StatusBadge status={s.status} />
            </div>
            <div className="card-meta">
              <div className="flex items-center gap-2">
                <Cpu size={14} /> <span>{s.model}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock size={14} /> <span>{new Date(s.updatedAt).toLocaleDateString()}</span>
              </div>
              <div className="flex items-center gap-2">
                <MessageSquare size={14} /> <span>{s.messageCount} messages</span>
              </div>
            </div>
            <div className="mt-2 text-[11px] font-mono text-secondary truncate bg-slate-50 p-1.5 rounded border border-border">
              {s.cwd}
            </div>
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="empty-state col-span-full">
            <MessageSquare className="empty-icon" />
            <p>No active sessions found. Create one to begin.</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderRooms = () => (
    <div className="main-content">
      <div className="content-header">
        <h1 className="header-title">Rooms</h1>
        <div className="header-actions">
          <button className="btn-primary !w-auto !py-2 !px-4 flex items-center gap-2" onClick={() => setIsCreatingRoom(true)}>
            <Plus size={16} /> New Room
          </button>
        </div>
      </div>
      <div className="card-grid">
        {rooms.map(r => (
          <div key={r.id} className="premium-card" onClick={() => openRoom(r.id)}>
            <div className="card-header">
              <h3 className="card-title">{r.title}</h3>
              <span className={`card-badge ${r.autoplay.active ? 'active' : ''}`}>
                {r.autoplay.active ? 'Autoplay Active' : 'Manual'}
              </span>
            </div>
            <div className="card-meta">
              <div className="flex items-center gap-2">
                <Users size={14} /> <span>{r.memberCount} agents</span>
              </div>
              <div className="flex items-center gap-2">
                <Zap size={14} /> <span>{r.autoplay.turnCount} turns</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock size={14} /> <span>{new Date(r.updatedAt).toLocaleDateString()}</span>
              </div>
            </div>
            <div className="mt-2 flex -space-x-2">
              {r.members.map((m, i) => (
                <div key={i} className="w-8 h-8 rounded-full bg-slate-200 border-2 border-white flex items-center justify-center text-[10px] font-bold" title={m.displayName}>
                  {m.displayName.charAt(0)}
                </div>
              ))}
            </div>
          </div>
        ))}
        {rooms.length === 0 && (
          <div className="empty-state col-span-full">
            <Users className="empty-icon" />
            <p>No active rooms found. Launch a room to start multi-agent collaboration.</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderTemplates = () => (
    <div className="main-content">
      <div className="content-header">
        <h1 className="header-title">Templates</h1>
      </div>
      <div className="card-grid">
        {templates.map(t => (
          <div key={t.id} className="premium-card" onClick={() => handleCreateTemplate(t.id)}>
            <div className="card-header">
              <h3 className="card-title">{t.title}</h3>
              <Zap size={16} className="text-amber-400" />
            </div>
            <p className="text-sm text-secondary leading-relaxed">
              {t.description}
            </p>
            <button className="btn-secondary !mt-auto !py-2 text-sm" disabled={isLaunchingTemplate}>
              {isLaunchingTemplate ? 'Launching…' : 'Use Template'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  const renderSessionDetail = () => {
    if (!sessionDetail) return null;
    const { session } = sessionDetail;
    
    return (
      <div className="main-content">
        <div className="content-header">
          <div className="flex items-center gap-4">
            <button className="p-2 hover:bg-black/5 rounded-full" onClick={() => setView('sessions')}>
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <div>
              <h1 className="header-title">{session.title}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <StatusBadge status={session.status} />
                <span className="text-[11px] text-secondary font-mono">{session.model}</span>
              </div>
            </div>
          </div>
          <div className="header-actions">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100 border border-border text-[12px] font-medium text-secondary">
              <FolderOpen size={14} /> {session.cwd}
            </div>
          </div>
        </div>

        <div className="timeline-container">
          {sessionActivity ? (
            <div className="max-w-[800px] mx-auto w-full px-4 py-3 rounded-2xl bg-blue-50 border border-blue-100 text-[13px] text-blue-700 font-medium">
              {sessionActivity}
            </div>
          ) : null}
          {session.persona ? (
            <div className="max-w-[800px] mx-auto w-full px-4 py-3 rounded-2xl bg-white/80 border border-border text-[13px] text-secondary leading-relaxed">
              {session.persona}
            </div>
          ) : null}
          {mergedSessionTimeline.map(item => (
            <TimelineItem key={item.id} item={item} />
          ))}
          <div ref={timelineEndRef} />
        </div>

        <div className="input-area">
          <div className="input-container">
            <input 
              className="input-field" 
              placeholder={`Message ${session.title}...`}
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
            />
            <button className="send-button" onClick={handleSendMessage} disabled={isSending || !inputText.trim()}>
              {isSending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderRoomDetail = () => {
    if (!roomDetail) return null;
    const { room, events } = roomDetail;

    return (
      <div className="main-content">
        <div className="content-header">
          <div className="flex items-center gap-4">
            <button className="p-2 hover:bg-black/5 rounded-full" onClick={() => setView('rooms')}>
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <div>
              <h1 className="header-title">{room.title}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`status-dot ${room.autoplay.active ? 'status-working' : 'status-idle'}`} />
                <span className="text-[11px] font-medium uppercase tracking-wider text-secondary">
                  {room.autoplay.active ? 'Autoplay Active' : 'Paused'} • {room.autoplay.turnCount} Turns
                </span>
              </div>
            </div>
          </div>
          <div className="header-actions">
            <button 
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-semibold text-sm transition-all ${room.autoplay.active ? 'bg-red-500 text-white' : 'bg-green-500 text-white'}`}
              onClick={toggleAutoplay}
            >
              {room.autoplay.active ? <><Square size={16} /> Stop Autoplay</> : <><Play size={16} /> Start Autoplay</>}
            </button>
          </div>
        </div>

        <div className="timeline-container">
          {room.instruction ? (
            <div className="max-w-[800px] mx-auto w-full px-4 py-3 rounded-2xl bg-white/80 border border-border text-[13px] text-secondary leading-relaxed">
              {room.instruction}
            </div>
          ) : null}
          {roomActivity ? (
            <div className="max-w-[800px] mx-auto w-full px-4 py-3 rounded-2xl bg-emerald-50 border border-emerald-100 text-[13px] text-emerald-700 font-medium">
              {roomActivity}
            </div>
          ) : null}
          {room.members.length ? (
            <div className="max-w-[800px] mx-auto w-full flex flex-wrap gap-2">
              {room.members.map(member => (
                <div key={member.sessionId} className="px-3 py-2 rounded-full bg-white border border-border text-[12px] text-secondary flex items-center gap-2">
                  <span className={`status-dot ${member.status === 'working' ? 'status-working' : member.status === 'error' ? 'status-error' : 'status-idle'}`} />
                  <span className="font-medium text-primary">{member.displayName}</span>
                  <span>{member.model}</span>
                </div>
              ))}
            </div>
          ) : null}
          {events.map(item => (
            <TimelineItem key={item.id} item={item} />
          ))}
          <div ref={timelineEndRef} />
        </div>

        <div className="input-area">
          <div className="input-container">
            <input 
              className="input-field" 
              placeholder="Broadcast message to all agents..."
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
            />
            <button className="send-button" onClick={handleSendMessage} disabled={isSending || !inputText.trim()}>
              {isSending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderContent = () => {
    switch (view) {
      case 'sessions': return renderSessions();
      case 'rooms': return renderRooms();
      case 'templates': return renderTemplates();
      case 'session-detail': return renderSessionDetail();
      case 'room-detail': return renderRoomDetail();
      default: return renderSessions();
    }
  };

  return (
    <div className="app-container">
      {renderSidebar()}
      {renderContent()}
      
      <AnimatePresence>
        {isCreatingSession && <CreateSessionModal />}
        {isCreatingRoom && <CreateRoomModal />}
      </AnimatePresence>
    </div>
  );
}
