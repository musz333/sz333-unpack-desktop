import { useEffect, useRef, type RefObject } from 'react';

/** 对话框内可获得焦点的元素选择器 */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 对话框无障碍行为（统一收口，避免每个弹窗各写一份）
 *  ① Esc 关闭
 *  ② 打开时把焦点移入对话框（优先 `[data-autofocus]`，否则第一个可聚焦元素）
 *  ③ Tab / Shift+Tab 焦点锁在对话框内循环，不逃逸到背景
 *  ④ 关闭后把焦点还原到打开前的触发元素
 *
 * 用法：把返回的 ref 挂到对话框根节点（需可聚焦，组件内已加 tabIndex={-1}）。
 *
 * 注意：onClose 用 ref 保存，避免调用方传入内联箭头函数时因身份变化
 * 导致 effect 反复重建 —— 那样会在每次父组件重渲染时把焦点抢回对话框首元素。
 */
export function useDialogA11y(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void
): void {
  const prevFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);

  // 始终指向最新的 onClose，但不参与下方 effect 的依赖
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    prevFocus.current = (document.activeElement as HTMLElement | null) ?? null;

    // 等一帧，确保对话框内容已渲染完成
    const raf = window.requestAnimationFrame(() => {
      if (!node) return;
      const preferred = node.querySelector<HTMLElement>('[data-autofocus]');
      const first = preferred ?? node.querySelector<HTMLElement>(FOCUSABLE) ?? node;
      first.focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;

      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const outside = !active || !node.contains(active);

      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };

    // 监听挂在对话框节点上（而非 document）：
    // 焦点始终锁在对话框内，按键会从内部冒泡到该节点；多个对话框叠加时，
    // 内层先收到并 stopPropagation，只有最上层响应 Esc。
    node?.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(raf);
      node?.removeEventListener('keydown', onKeyDown);
      // 关闭后把焦点还给触发元素（元素可能已被卸载，做一次存在性判断）
      const back = prevFocus.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [open, ref]);
}
