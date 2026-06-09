import React, { useState, useEffect, useRef } from 'react';

const CountUp = ({ end, duration = 1.5, suffix = '', prefix = '' }) => {
  const [count, setCount] = useState(0);
  const elementRef = useRef(null);
  const animationTriggered = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && !animationTriggered.current) {
          animationTriggered.current = true;
          startCountAnimation();
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.1 }
    );

    if (elementRef.current) {
      observer.observe(elementRef.current);
    }

    return () => {
      if (elementRef.current) {
        observer.disconnect();
      }
    };
  }, [end, duration]);

  const startCountAnimation = () => {
    let startTimestamp = null;
    const endVal = parseFloat(end.toString().replace(/,/g, ''));
    
    if (isNaN(endVal)) {
      setCount(end); // fallback if it's not a number
      return;
    }

    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / (duration * 1000), 1);
      
      // Easing function outQuad: slow down at end
      const easeProgress = progress * (2 - progress);
      const currentVal = Math.floor(easeProgress * endVal);
      
      setCount(currentVal);

      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        setCount(endVal); // Ensure exact final value
      }
    };

    window.requestAnimationFrame(step);
  };

  const formatNumber = (num) => {
    return num.toLocaleString();
  };

  return (
    <span ref={elementRef} className="tabular-nums font-black">
      {prefix}
      {formatNumber(count)}
      {suffix}
    </span>
  );
};

export default CountUp;
