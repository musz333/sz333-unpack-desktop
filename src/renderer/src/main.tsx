import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { useStore } from './store';

// 开发期调试钩子：便于用探针脚本注入状态（生产环境同样可用，不暴露额外权限）
(window as unknown as { __store?: typeof useStore }).__store = useStore;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
