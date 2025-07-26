import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'

// Generate subtle pastel color from string
function stringToPastelColor(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  const h = hash % 360
  return `hsl(${h}, 40%, 85%)`
}

// TypingDots component with animated dots "..."
function TypingDots() {
  return (
    <span className="typing-dots">
      <style>{`
        .typing-dots {
          display: inline-flex;
          gap: 2px;
          align-items: center;
        }
        .typing-dots span {
          width: 8px;
          height: 8px;
          background: rgba(0, 0, 0, 0.6);
          border-radius: 50%;
          animation: typing-bounce 1.4s infinite ease-in-out;
          opacity: 0.4;
        }
        .typing-dots span:nth-child(1) {
          animation-delay: 0s;
        }
        .typing-dots span:nth-child(2) {
          animation-delay: 0.2s;
        }
        .typing-dots span:nth-child(3) {
          animation-delay: 0.4s;
        }
        @keyframes typing-bounce {
          0%, 60%, 100% { 
            transform: translateY(0); 
            opacity: 0.4;
          }
          30% { 
            transform: translateY(-10px); 
            opacity: 1;
          }
        }
        .animate-fade-in {
          animation: fadeIn 0.3s ease-in-out;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <span></span>
      <span></span>
      <span></span>
    </span>
  )
}

function App() {
  const [session, setSession] = useState(null)
  const [messages, setMessages] = useState([])
  const [newMessage, setNewMessage] = useState('')
  const [usersOnline, setUsersOnline] = useState([])
  const [typingUsers, setTypingUsers] = useState(new Map()) // Changed to Map for better timeout management
  const roomOneRef = useRef(null)
  const messagesEndRef = useRef(null)
  const chatBoxRef = useRef(null)
  const typingTimeoutsRef = useRef(new Map()) // Store individual timeouts per user for received events
  const sendTypingTimeoutRef = useRef(null); // For debouncing sending 'typing' events

  // Scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const signIn = async () => {
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google' })
    if (error) console.error('Sign in error:', error)
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) console.error('Sign out error:', error)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  // Load initial messages
  useEffect(() => {
    if (!session?.user) return
    
    const loadMessages = async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .order('timestamp', { ascending: true })
      
      if (error) {
        console.error('Load messages error:', error)
      } else {
        setMessages(data || [])
      }
    }
    
    loadMessages()
  }, [session])

  // Helper function to clear typing timeout for a user (received events)
  const clearTypingTimeout = (userId) => {
    const timeout = typingTimeoutsRef.current.get(userId)
    if (timeout) {
      clearTimeout(timeout)
      typingTimeoutsRef.current.delete(userId)
    }
  }

  // Helper function to remove typing user
  const removeTypingUser = (userId) => {
    setTypingUsers((prev) => {
      const newMap = new Map(prev)
      newMap.delete(userId)
      return newMap
    })
    clearTypingTimeout(userId)
  }

  // Realtime subscription - separate effect for better reliability
  useEffect(() => {
    if (!session?.user) {
      setUsersOnline([])
      setTypingUsers(new Map())
      roomOneRef.current = null
      // Clear all typing timeouts for received events
      typingTimeoutsRef.current.forEach(timeout => clearTimeout(timeout))
      typingTimeoutsRef.current.clear()
      // Clear sender-side typing timeout
      if (sendTypingTimeoutRef.current) {
        clearTimeout(sendTypingTimeoutRef.current);
        sendTypingTimeoutRef.current = null;
      }
      return
    }

    // ⭐ FIX: Use a fixed, consistent channel name for all users to join the same room
    const channelName = 'room_one'; 
    const channel = supabase.channel(channelName, {
      config: { 
        presence: { key: session.user.id }
      }
    })

    roomOneRef.current = channel

    // Store user info for consistent access
    const currentUserId = session.user.id
    const currentUserEmail = session.user.user_metadata?.email

    // Presence handling
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState()
      setUsersOnline(Object.keys(state))
    })

    // Typing indicator handling (receiving end)
    channel.on('broadcast', { event: 'typing' }, (payload) => {
      const { userId, userEmail, userName, userAvatar, isTyping } = payload.payload
      
      // Don't show typing indicator for current user (they know they're typing)
      if (userId && userId !== currentUserId) {
        if (isTyping) {
          // Add or update typing user in the state
          setTypingUsers((prev) => {
            const newMap = new Map(prev)
            newMap.set(userId, {
              id: userId,
              email: userEmail,
              name: userName,
              avatar: userAvatar
            })
            return newMap
          })
          
          // Clear any existing timeout for this user (resets the 3-second timer)
          clearTypingTimeout(userId)
          
          // Set new timeout to remove typing indicator if no further 'typing' events are received
          const timeout = setTimeout(() => {
            removeTypingUser(userId)
          }, 3000) // Remove after 3 seconds of inactivity from that user
          
          typingTimeoutsRef.current.set(userId, timeout)
        } else {
          // Explicitly stop typing (if a 'stop_typing' broadcast is received)
          removeTypingUser(userId)
        }
      }
    })

    // Listen for explicit 'stop_typing' event (good for robustness, though 'isTyping: false' handles it)
    channel.on('broadcast', { event: 'stop_typing' }, (payload) => {
      const { userId } = payload.payload
      if (userId && userId !== currentUserId) {
        removeTypingUser(userId)
      }
    })

    // Message changes handling - simplified to just INSERT for new messages
    channel.on(
      'postgres_changes',
      { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'messages' 
      },
      (payload) => {
        console.log('Real-time INSERT payload:', payload) // Debug log
        
        // Only add if it's not from the current user (to avoid duplicates with optimistic updates)
        if (payload.new && payload.new.user !== currentUserId) {
          setMessages((prevMessages) => {
            // Double-check for duplicates based on message ID
            const messageExists = prevMessages.some(m => m.id === payload.new.id)
            if (!messageExists) {
              const updatedMessages = [...prevMessages, payload.new]
              // Sort by timestamp to ensure proper chronological order
              updatedMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
              return updatedMessages
            }
            return prevMessages
          })
          
          // Remove typing indicator for the user who just sent a message
          removeTypingUser(payload.new.user)
        }
      }
    )

    // Subscribe to the channel
    const subscribeToChannel = async () => {
      channel.subscribe(async (status) => {
        console.log('Subscription status:', status, 'Channel:', channelName)
        
        if (status === 'SUBSCRIBED') {
          // Track user presence in the channel
          try {
            await channel.track({
              user: currentUserId,
              name: session.user.user_metadata?.full_name || 'User',
              email: currentUserEmail,
            })
            console.log('User presence tracked successfully')
          } catch (error) {
            console.error('Error tracking presence:', error)
          }
        } else if (status === 'CHANNEL_ERROR') {
          console.error('Channel subscription error')
        } else if (status === 'TIMED_OUT') {
          console.error('Channel subscription timed out')
        }
      })
    }

    subscribeToChannel()

    // Cleanup function for when the component unmounts or session changes
    return () => {
      console.log('Cleaning up channel:', channelName)
      
      // Attempt to send a stop typing event before unsubscribing
      if (channel && channel.state !== 'closed' && session?.user) {
        channel.send({
          type: 'broadcast',
          event: 'stop_typing',
          payload: { userId: session.user.id },
        })
      }
      
      // Clear all timeouts for received typing indicators
      typingTimeoutsRef.current.forEach(timeout => clearTimeout(timeout))
      typingTimeoutsRef.current.clear()
      
      // Clear the debounced sending typing timeout
      if (sendTypingTimeoutRef.current) {
        clearTimeout(sendTypingTimeoutRef.current);
        sendTypingTimeoutRef.current = null;
      }

      // Unsubscribe from the Supabase channel
      if (channel && channel.state !== 'closed') {
        channel.unsubscribe()
      }
      roomOneRef.current = null // Clear the ref
    }
  }, [session?.user?.id]) // Re-run effect if session user ID changes

  // Debounced handler for sending typing status (sender's side)
  const handleTyping = () => {
    if (roomOneRef.current && session?.user) {
      // Clear any existing timeout for sending a 'typing' event
      if (sendTypingTimeoutRef.current) {
        clearTimeout(sendTypingTimeoutRef.current);
      }

      // Send a 'typing' event immediately
      roomOneRef.current.send({
        type: 'broadcast',
        event: 'typing',
        payload: { 
          userId: session.user.id,
          userEmail: session.user.user_metadata?.email,
          userName: session.user.user_metadata?.full_name || 
                    session.user.user_metadata?.name || 'User',
          userAvatar: session.user.user_metadata?.avatar_url || 
                        session.user.user_metadata?.avatar || '',
          isTyping: true // Indicate that the user IS typing
        },
      });

      // Set a new timeout to send 'stop_typing' if no further typing occurs within 1 second
      sendTypingTimeoutRef.current = setTimeout(() => {
        handleStopTyping(); // Automatically stop typing after a brief pause
      }, 1000); // 1 second debounce
    }
  }

  // Handler for explicitly stopping typing (sender's side)
  const handleStopTyping = () => {
    if (roomOneRef.current && session?.user) {
      // Clear any pending debounced typing event (so it doesn't send 'stop_typing' twice)
      if (sendTypingTimeoutRef.current) {
        clearTimeout(sendTypingTimeoutRef.current);
        sendTypingTimeoutRef.current = null;
      }
      
      // Send a 'stop_typing' event broadcast
      roomOneRef.current.send({
        type: 'broadcast',
        event: 'stop_typing',
        payload: { userId: session.user.id },
      })
    }
  }

  const SendMessage = async (e) => {
    e.preventDefault()
    if (!newMessage.trim() || !session?.user) return

    // Immediately send a stop typing event when a message is sent
    handleStopTyping()

    const messageData = {
      id: crypto.randomUUID(), // Unique ID for optimistic UI updates and de-duplication
      user: session.user.id,
      avatar: session.user.user_metadata?.avatar_url || 
              session.user.user_metadata?.avatar || '',
      message: newMessage.trim(),
      timestamp: new Date().toISOString(),
      name: session.user.user_metadata?.full_name || 
            session.user.user_metadata?.name || 'User',
    }

    // Optimistic UI update: Add the message to the display immediately
    setMessages(prev => [...prev, messageData])
    setNewMessage('') // Clear the input field

    try {
      const { error } = await supabase
        .from('messages')
        .insert([messageData])

      if (error) {
        console.error('Insert failed:', error)
        // Rollback optimistic update on error: remove the message
        setMessages(prev => prev.filter(msg => msg.id !== messageData.id))
        setNewMessage(newMessage) // Restore the message text
      }
    } catch (err) {
      console.error('Send message error:', err)
      // Rollback optimistic update on error: remove the message
      setMessages(prev => prev.filter(msg => msg.id !== messageData.id))
      setNewMessage(newMessage) // Restore the message text
    }
  }

  // Render sign-in screen if no session
  if (!session) {
    return (
      <div className="w-full h-screen flex justify-center items-center bg-black">
        <button
          onClick={signIn}
          className="bg-blue-500 text-white px-6 py-3 rounded-lg hover:bg-blue-600 transition-colors"
        >
          Sign In with Google
        </button>
      </div>
    )
  }

  // Main chat UI
  return (
    <div className="w-full flex h-screen justify-center items-center p-4 bg-[#111]">
      <div className="border border-gray-700 max-w-6xl w-full min-h-[600px] rounded-lg flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center p-4 border-b border-gray-700">
          <div>
            <p className="text-gray-300">
              Signed in as {session.user.user_metadata?.name || 'User'}
            </p>
            <p className="text-gray-400 italic text-sm">
              {usersOnline.length} User{usersOnline.length !== 1 ? 's' : ''} Online
            </p>
          </div>
          <button
            onClick={signOut}
            className="bg-red-500 text-white px-4 py-2 rounded-lg hover:bg-red-600 transition-colors"
          >
            Sign Out
          </button>
        </div>

        {/* Chat Box - displays messages */}
        <div
          ref={chatBoxRef}
          className="flex-1 p-4 space-y-2 border-b border-gray-700 overflow-y-auto"
          style={{ maxHeight: '500px' }} // Restrict height and enable scrolling
        >
          {messages.map((msg) => {
            const isSender = msg.user === session.user.id
            const userColor = isSender
              ? 'hsl(120, 50%, 75%)' // Greenish for sender
              : stringToPastelColor(msg.user || msg.name || 'default') // Pastel for others

            return (
              <div
                key={msg.id}
                className={`flex gap-2 items-end ${
                  isSender ? 'justify-end' : 'justify-start'
                } animate-fade-in`} // Align messages left/right
              >
                {!isSender && msg.avatar && ( // Show avatar for others on the left
                  <img
                    src={msg.avatar}
                    alt="avatar"
                    className="w-8 h-8 rounded-full"
                  />
                )}
                <div
                  className="p-3 rounded-xl max-w-[70%] shadow relative"
                  style={{
                    backgroundColor: userColor,
                    color: 'black',
                    textAlign: isSender ? 'right' : 'left',
                  }}
                >
                  <p className="font-semibold text-sm">{msg.name}</p>
                  <p className="text-base">{msg.message}</p>
                  <p className="text-xs text-gray-600 mt-1">
                    {new Date(msg.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                {isSender && msg.avatar && ( // Show avatar for sender on the right
                  <img
                    src={msg.avatar}
                    alt="avatar"
                    className="w-8 h-8 rounded-full"
                  />
                )}
              </div>
            )
          })}
          <div ref={messagesEndRef}></div> {/* Empty div to scroll to */}
        </div>

        {/* Typing Indicator Display */}
        {typingUsers.size > 0 && (
          <div className="px-4 pb-2 space-y-2">
            {Array.from(typingUsers.values()).map((user) => {
              const color = stringToPastelColor(user.id || user.name || 'default')

              return (
                <div
                  key={user.id}
                  className="flex gap-2 items-end justify-start animate-fade-in"
                >
                  {/* User Avatar or Initial */}
                  <div className="flex-shrink-0">
                    {user.avatar ? (
                      <img
                        src={user.avatar}
                        alt={`${user.name} avatar`}
                        className="w-8 h-8 rounded-full"
                      />
                    ) : (
                      <div 
                        className="w-8 h-8 rounded-full flex items-center justify-center text-white font-semibold text-sm"
                        style={{ backgroundColor: color }}
                      >
                        {user.name?.charAt(0).toUpperCase() || '?'}
                      </div>
                    )}
                  </div>
                  
                  {/* Typing Bubble with animated dots */}
                  <div
                    className="px-4 py-3 rounded-xl shadow-sm max-w-[100px] min-h-[45px] flex items-center justify-center"
                    style={{
                      backgroundColor: color,
                      color: 'black',
                    }}
                  >
                    <TypingDots />
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Message Input Area */}
        <div className="flex flex-col sm:flex-row p-4 border-t border-gray-700 gap-2">
          <input
            type="text"
            placeholder="Type a message..."
            className="p-2 w-full bg-gray-800 text-white rounded-lg border border-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
            value={newMessage}
            onChange={(e) => {
              setNewMessage(e.target.value)
              if (e.target.value.trim()) {
                handleTyping() // Call debounced typing handler
              } else {
                handleStopTyping() // Immediately stop typing if input is empty
              }
            }}
            onBlur={handleStopTyping} // Stop typing if input loses focus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { // Send on Enter, allow Shift+Enter for new line
                e.preventDefault()
                SendMessage(e)
              }
            }}
            autoFocus // Focus the input on load
          />
          <button
            onClick={SendMessage}
            disabled={!newMessage.trim()} // Disable send button if message is empty
            className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

export default App