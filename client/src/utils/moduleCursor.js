/**
 * Module Cursor Effect
 * A highly professional, distraction-free effect for workspace modules.
 * Keeps the native OS cursor for zero-delay precision.
 * Adds a soft, premium radial background spotlight that follows the cursor smoothly.
 */
export function initModuleCursor() {
  if (typeof window === 'undefined') return;

  document.body.classList.add('module-cursor-active');

  // Remove any legacy custom cursor elements
  const existingDot = document.getElementById('module-cursor-dot');
  const existingGlow = document.getElementById('module-cursor-glow');
  const existingSpotlight = document.getElementById('module-cursor-spotlight');
  if (existingDot) existingDot.remove();
  if (existingGlow) existingGlow.remove();
  if (existingSpotlight) existingSpotlight.remove();

  // Also remove any landing-page cursor elements that might linger
  const landingDot = document.getElementById('custom-cursor-dot');
  const landingRing = document.getElementById('custom-cursor-ring');
  if (landingDot) landingDot.remove();
  if (landingRing) landingRing.remove();
  document.querySelectorAll('.cursor-trail').forEach(el => el.remove());
  document.body.classList.remove('custom-cursor-active');

  // Create the soft background spotlight element
  const spotlight = document.createElement('div');
  spotlight.id = 'module-cursor-spotlight';
  Object.assign(spotlight.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '320px',
    height: '320px',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(99, 102, 241, 0.08) 0%, rgba(139, 92, 246, 0.02) 55%, transparent 100%)',
    pointerEvents: 'none',
    zIndex: '9999',
    opacity: '0',
    transform: 'translate(-50%, -50%)',
    transition: 'width 0.4s cubic-bezier(0.16, 1, 0.3, 1), height 0.4s cubic-bezier(0.16, 1, 0.3, 1), background 0.4s ease, opacity 0.3s ease',
    willChange: 'transform'
  });
  document.body.appendChild(spotlight);

  let mouse = { x: 0, y: 0 };
  let spotlightPos = { x: 0, y: 0 };
  let isVisible = false;
  let isHovered = false;
  let animationId;

  const onMouseMove = (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;

    if (!isVisible) {
      spotlight.style.opacity = '1';
      isVisible = true;
    }
  };

  window.addEventListener('mousemove', onMouseMove);

  const updateSpotlight = () => {
    // Smooth interpolation (lerp) for the background glow positioning
    spotlightPos.x += (mouse.x - spotlightPos.x) * 0.12;
    spotlightPos.y += (mouse.y - spotlightPos.y) * 0.12;
    spotlight.style.transform = `translate3d(${spotlightPos.x}px, ${spotlightPos.y}px, 0) translate(-50%, -50%)`;

    animationId = requestAnimationFrame(updateSpotlight);
  };
  updateSpotlight();

  // Spotlight reacts when hovering interactive controls
  const onMouseOver = (e) => {
    const target = e.target;
    const isInteractive = target.closest('button, a, input, select, textarea, [role="button"], .interactive-hover');
    if (isInteractive && !isHovered) {
      isHovered = true;
      spotlight.style.width = '240px';
      spotlight.style.height = '240px';
      spotlight.style.background = 'radial-gradient(circle, rgba(139, 92, 246, 0.12) 0%, rgba(99, 102, 241, 0.03) 60%, transparent 100%)';
    }
  };

  const onMouseOut = (e) => {
    const target = e.target;
    const isInteractive = target.closest('button, a, input, select, textarea, [role="button"], .interactive-hover');
    if (isInteractive && isHovered) {
      isHovered = false;
      spotlight.style.width = '320px';
      spotlight.style.height = '320px';
      spotlight.style.background = 'radial-gradient(circle, rgba(99, 102, 241, 0.08) 0%, rgba(139, 92, 246, 0.02) 55%, transparent 100%)';
    }
  };

  window.addEventListener('mouseover', onMouseOver);
  window.addEventListener('mouseout', onMouseOut);

  // Premium micro-click ripple on buttons
  const onClickRipple = (e) => {
    const button = e.target.closest('button, .ripple-button');
    if (!button) return;

    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple-span';

    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;

    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;

    if (window.getComputedStyle(button).position === 'static') {
      button.style.position = 'relative';
    }
    button.style.overflow = 'hidden';

    button.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  };

  window.addEventListener('click', onClickRipple);

  // Cleanup
  return () => {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseover', onMouseOver);
    window.removeEventListener('mouseout', onMouseOut);
    window.removeEventListener('click', onClickRipple);
    cancelAnimationFrame(animationId);

    document.body.classList.remove('module-cursor-active');
    if (spotlight) spotlight.remove();
  };
}
