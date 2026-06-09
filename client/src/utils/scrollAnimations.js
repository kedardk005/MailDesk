export function initScrollAnimations() {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return () => {};

  const options = {
    root: null, // viewport
    rootMargin: '0px',
    threshold: 0.15 // trigger when 15% visible
  };

  const observer = new IntersectionObserver((entries, self) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('active');
        
        // Trigger count-up event if element has number count up
        if (entry.target.classList.contains('count-up-trigger')) {
          const countUpEvent = new CustomEvent('start-count-up', {
            detail: { targetId: entry.target.id }
          });
          window.dispatchEvent(countUpEvent);
        }
        
        // Once visible, stop observing
        self.unobserve(entry.target);
      }
    });
  }, options);

  const observeElements = () => {
    const targets = document.querySelectorAll(
      '.reveal-element, .reveal-element-left, .reveal-element-right, .stagger-reveal, .count-up-trigger'
    );
    targets.forEach(target => {
      // Don't observe if already active
      if (!target.classList.contains('active')) {
        observer.observe(target);
      }
    });
  };

  // Run on start
  setTimeout(observeElements, 100);

  // Monitor DOM changes to observe newly rendered items if any
  const mutationObserver = new MutationObserver(() => {
    observeElements();
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Return cleanup
  return () => {
    observer.disconnect();
    mutationObserver.disconnect();
  };
}
