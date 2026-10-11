import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/app.css';
import './styles/pro.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
