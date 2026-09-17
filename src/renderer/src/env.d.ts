/// <reference types="vite/client" />

declare module '*.css';
declare module '*.svg';
declare module '*.png';

interface Window {
  menuBridge?: {
    onAdd: (cb: () => void) => () => void;
  };
}
