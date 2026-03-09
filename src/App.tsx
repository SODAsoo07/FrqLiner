import { useState } from 'react';
import { FrqProvider } from './components/FrqContext';
import { LanguageProvider } from './components/LanguageContext';
import { Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import Editor from './components/Editor';

function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  return (
    <LanguageProvider>
      <FrqProvider>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', fontFamily: 'sans-serif', color: '#333' }}>
          <Toolbar toggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} isSidebarOpen={isSidebarOpen} />
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {isSidebarOpen && <Sidebar />}
            <Editor />
          </div>
        </div>
      </FrqProvider>
    </LanguageProvider>
  )
}

export default App
