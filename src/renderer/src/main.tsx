import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { useStore } from './store';

// 开发期调试钩子：便于用探针脚本注入状态。
// 生产构建必须剥离——不要把内部 store 暴露到 window（缩小攻击面 / 避免误用）。
if (import.meta.env.DEV) {
  (window as unknown as { __store?: typeof useStore }).__store = useStore;
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
