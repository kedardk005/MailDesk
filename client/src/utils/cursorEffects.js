export function initCursorEffects() {
  if (typeof window === 'undefined') return;

  document.body.classList.add('custom-cursor-active');

  // Remove existing cursor elements if any
  const existingDot = document.getElementById('custom-cursor-dot');
  const existingRing = document.getElementById('custom-cursor-ring');
  if (existingDot) existingDot.remove();
  if (existingRing) existingRing.remove();
  document.querySelectorAll('.cursor-trail').forEach(el => el.remove());

  // Create dot
  const dot = document.createElement('div');
  dot.id = 'custom-cursor-dot';
  dot.className = 'custom-cursor-dot';
  document.body.appendChild(dot);

  // Create ring
  const ring = document.createElement('div');
  ring.id = 'custom-cursor-ring';
  ring.className = 'custom-cursor-ring';
  document.body.appendChild(ring);

  // Create 5 trailing dots
  const trailDotsCount = 5;
  const trailDots = [];
  for (let i = 0; i < trailDotsCount; i++) {
    const trail = document.createElement('div');
    trail.className = 'cursor-trail';
    // Stagger sizes and opacity
    const ratio = (trailDotsCount - i) / trailDotsCount;
    trail.style.width = `${Math.max(2, 6 * ratio)}px`;
    trail.style.height = `${Math.max(2, 6 * ratio)}px`;
    trail.style.opacity = `${0.6 * ratio}`;
    trail.style.backgroundColor = '#8B5CF6';
    trail.style.transition = 'opacity 0.2s ease';
    document.body.appendChild(trail);
    trailDots.push({
      el: trail,
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0
    });
  }

  // Cursor coordinates
  let mouse = { x: 0, y: 0 };
  let dotPos = { x: 0, y: 0 };
  let ringPos = { x: 0, y: 0 };

  // Make cursor elements visible when mouse moves
  let isVisible = false;
  let isHovered = false;
  let isMouseDown = false;

  const onMouseMove = (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;

    if (!isVisible) {
      dot.style.opacity = '1';
      ring.style.opacity = '1';
      trailDots.forEach(trail => {
        trail.el.style.opacity = '0.5';
      });
      isVisible = true;
    }
  };

  window.addEventListener('mousemove', onMouseMove);

  // Smooth lerp movement loop
  let animationId;
  const updateCursor = () => {
    // Dot follows mouse directly
    dotPos.x = mouse.x;
    dotPos.y = mouse.y;

    // Determine dynamic transform scales
    let dotScale = 'scale(1)';
    let ringScale = 'scale(1)';

    if (isMouseDown) {
      dotScale = 'scaleX(1.6) scaleY(0.4)';
      ringScale = 'scale(0.6)';
    } else if (isHovered) {
      dotScale = 'scale(3)';
      ringScale = 'scale(0.4)';
    }

    dot.style.transform = `translate3d(${dotPos.x}px, ${dotPos.y}px, 0) translate(-50%, -50%) ${dotScale}`;

    // Ring follows with lerp (0.12 delay)
    ringPos.x += (mouse.x - ringPos.x) * 0.12;
    ringPos.y += (mouse.y - ringPos.y) * 0.12;
    ring.style.transform = `translate3d(${ringPos.x}px, ${ringPos.y}px, 0) translate(-50%, -50%) ${ringScale}`;

    // Trailing dots move with delay
    let prevX = mouse.x;
    let prevY = mouse.y;
    
    trailDots.forEach((trail, index) => {
      // Each trailing dot follows the one ahead of it
      trail.x += (prevX - trail.x) * 0.25;
      trail.y += (prevY - trail.y) * 0.25;
      trail.el.style.transform = `translate3d(${trail.x}px, ${trail.y}px, 0) translate(-50%, -50%)`;
      prevX = trail.x;
      prevY = trail.y;
    });

    animationId = requestAnimationFrame(updateCursor);
  };
  updateCursor();

  // Click squish effect
  const onMouseDown = () => {
    isMouseDown = true;
  };

  const onMouseUp = () => {
    isMouseDown = false;
  };

  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);

  // Hover states on buttons/links
  const onMouseOverGlobal = (e) => {
    const target = e.target;
    // Check if hovered element is interactive
    const isInteractive = target.closest('button, a, input, select, textarea, [role="button"], .interactive-hover');
    if (isInteractive) {
      isHovered = true;
      document.body.classList.add('cursor-hover');
      // Hide trail dots on hover for clean look
      trailDots.forEach(trail => {
        trail.el.style.opacity = '0';
      });
    }
  };

  const onMouseOutGlobal = (e) => {
    const target = e.target;
    const isInteractive = target.closest('button, a, input, select, textarea, [role="button"], .interactive-hover');
    if (isInteractive) {
      isHovered = false;
      document.body.classList.remove('cursor-hover');
      trailDots.forEach(trail => {
        trail.el.style.opacity = '0.5';
      });
    }
  };

  window.addEventListener('mouseover', onMouseOverGlobal);
  window.addEventListener('mouseout', onMouseOutGlobal);

  // Magnetic Pull Effect on buttons
  const magneticElements = new Map();

  const onMouseMoveMagnetic = (e) => {
    const button = e.target.closest('button, a, .magnetic-button');
    if (!button) {
      // Snap any currently pulled button back to center
      magneticElements.forEach((val, key) => {
        key.style.transform = 'translate3d(0px, 0px, 0px)';
        magneticElements.delete(key);
      });
      return;
    }

    const rect = button.getBoundingClientRect();
    const btnX = rect.left + rect.width / 2;
    const btnY = rect.top + rect.height / 2;
    
    // Distance between cursor and button center
    const distX = e.clientX - btnX;
    const distY = e.clientY - btnY;
    const distance = Math.sqrt(distX * distX + distY * distY);

    // Pull factor (max 10px pull)
    if (distance < 60) {
      const pullX = (distX / 60) * 8;
      const pullY = (distY / 60) * 8;
      button.style.transform = `translate3d(${pullX}px, ${pullY}px, 0)`;
      button.style.transition = 'transform 0.1s cubic-bezier(0.25, 1, 0.5, 1)';
      magneticElements.set(button, true);
    } else {
      button.style.transform = 'translate3d(0px, 0px, 0px)';
      button.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
      magneticElements.delete(button);
    }
  };

  window.addEventListener('mousemove', onMouseMoveMagnetic);

  // Button Ripple Effect
  const onClickRipple = (e) => {
    const button = e.target.closest('button, .ripple-button');
    if (!button) return;

    // Create ripple span
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple-span';
    
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;

    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;

    // Make sure button has position-relative
    if (window.getComputedStyle(button).position === 'static') {
      button.style.position = 'relative';
    }
    button.style.overflow = 'hidden';

    button.appendChild(ripple);

    setTimeout(() => {
      ripple.remove();
    }, 600);
  };

  window.addEventListener('click', onClickRipple);

  // Cleanup function
  return () => {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mouseover', onMouseOverGlobal);
    window.removeEventListener('mouseout', onMouseOutGlobal);
    window.removeEventListener('mousemove', onMouseMoveMagnetic);
    window.removeEventListener('click', onClickRipple);
    cancelAnimationFrame(animationId);
    
    document.body.classList.remove('custom-cursor-active');
    if (dot) dot.remove();
    if (ring) ring.remove();
    trailDots.forEach(trail => trail.el.remove());
  };
}
