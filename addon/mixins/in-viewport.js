import { assign } from '@ember/polyfills';
import Mixin from '@ember/object/mixin';
import { typeOf } from '@ember/utils';
import { assert } from '@ember/debug';
import { set, get, setProperties } from '@ember/object';
import { next, bind, debounce, scheduleOnce } from '@ember/runloop';
import { not } from '@ember/object/computed';
import { getOwner } from '@ember/application';
import canUseDOM from 'ember-in-viewport/utils/can-use-dom';
import canUseRAF from 'ember-in-viewport/utils/can-use-raf';
import findElem from 'ember-in-viewport/utils/find-elem';
import canUseIntersectionObserver from 'ember-in-viewport/utils/can-use-intersection-observer';
import isInViewport from 'ember-in-viewport/utils/is-in-viewport';
import checkScrollDirection from 'ember-in-viewport/utils/check-scroll-direction';

const rAFIDS = {};
const lastDirection = {};
const lastPosition = {};

export default Mixin.create({
  /**
   * IntersectionObserverEntry
   *
   * @property intersectionObserver
   * @default null
   */
  intersectionObserver: null,
  viewportExited: not('viewportEntered').readOnly(),

  init() {
    this._super(...arguments);
    const options = assign({
      viewportUseRAF: canUseRAF(),
      viewportUseIntersectionObserver: canUseIntersectionObserver(),
      viewportEntered: false,
      viewportListeners: []
    }, this._buildOptions());

    setProperties(this, options);
    this._triggerDidScrollDirectionHandler = this._triggerDidScrollDirectionHandler.bind(this);
    this._setViewportEnteredHandler = this._setViewportEnteredHandler.bind(this);
  },

  didInsertElement() {
    this._super(...arguments);

    if (!canUseDOM) {
      return;
    }

    const viewportEnabled = get(this, 'viewportEnabled');
    if (viewportEnabled) {
      this._startListening();
    }
  },

  willDestroyElement() {
    this._super(...arguments);
    this._unbindListeners();
  },

  _buildOptions(defaultOptions = {}) {
    const owner = getOwner(this);

    if (owner) {
      return assign(defaultOptions, owner.lookup('config:in-viewport'));
    }
  },

  _startListening() {
    this._setInitialViewport();
    this._addObserverIfNotSpying();
    this._bindScrollDirectionListener();

    if (!get(this, 'viewportUseRAF')) {
      get(this, 'viewportListeners').forEach((listener) => {
        let { context, event } = listener;
        context = get(this, 'scrollableArea') || context;
        this._bindListeners(context, event);
      });
    }
  },

  _addObserverIfNotSpying() {
    if (!get(this, 'viewportSpy')) {
      this.addObserver('viewportEntered', this, this._unbindIfEntered);
    }
  },

  _setViewportEntered() {
    const scrollableArea = get(this, 'scrollableArea') ? document.querySelector(get(this, 'scrollableArea')) : null;

    const element = get(this, 'element');

    if (!element) {
      return;
    }

    if (get(this, 'viewportUseIntersectionObserver')) {
      // https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
      // IntersectionObserver takes either a Document Element or null for `root`
      const { top = 0, left = 0, bottom = 0, right = 0 } = this.viewportTolerance;
      const options = {
        root: scrollableArea,
        rootMargin: `${top}px ${right}px ${bottom}px ${left}px`,
        threshold: get(this, 'intersectionThreshold')
      };

      this.intersectionObserver = new IntersectionObserver(bind(this, this._onIntersection), options);
      this.intersectionObserver.observe(element);
    } else {
      const height = scrollableArea ? scrollableArea.offsetHeight : window.innerHeight;
      const width = scrollableArea ? scrollableArea.offsetWidth : window.innerWidth;
      const boundingClientRect = element.getBoundingClientRect();

      if (boundingClientRect) {
        this._triggerDidAccessViewport(
          isInViewport(
            boundingClientRect,
            height,
            width,
            get(this, 'viewportTolerance')
          )
        );
        if (get(this, 'viewportUseRAF')) {
          rAFIDS[get(this, 'elementId')] = window.requestAnimationFrame(
            bind(this, this._setViewportEntered)
          );
        }
      }
    }
  },

  /**
   * callback provided to IntersectionObserver
   *
   * @method _onIntersection
   * @param {Array} - entries
   */
  _onIntersection(entries) {
    if (!this.isDestroyed && !this.isDestroying) {
      const entry = entries[0];

      if (entry.isIntersecting) {
        set(this, 'viewportEntered', true);
        this.trigger('didEnterViewport');
      } else if (entry.intersectionRatio <= 0) { // exiting viewport
        set(this, 'viewportEntered', false);
        this.trigger('didExitViewport');
      }
    }
  },

  _triggerDidScrollDirection(contextEl = null, sensitivity = 1) {
    assert('You must pass a valid context element to _triggerDidScrollDirection', contextEl);
    assert('sensitivity cannot be 0', sensitivity);

    const elementId = get(this, 'elementId');
    const lastDirectionForEl = lastDirection[elementId];
    const lastPositionForEl = lastPosition[elementId];
    const newPosition = {
      top: contextEl.scrollTop,
      left: contextEl.scrollLeft
    };

    const scrollDirection = checkScrollDirection(lastPositionForEl, newPosition, sensitivity);
    const directionChanged = scrollDirection !== lastDirectionForEl;

    if (scrollDirection && directionChanged && get(this, 'viewportEntered')) {
      this.trigger('didScroll', scrollDirection);
      lastDirection[elementId] = scrollDirection;
    }

    lastPosition[elementId] = newPosition;
  },

  _triggerDidAccessViewport(hasEnteredViewport = false) {
    const viewportEntered = get(this, 'viewportEntered');
    const didEnter = !viewportEntered && hasEnteredViewport;
    const didLeave = viewportEntered && !hasEnteredViewport;
    let triggeredEventName = '';

    if (didEnter) {
      triggeredEventName = 'didEnterViewport';
    }

    if (didLeave) {
      triggeredEventName = 'didExitViewport';
    }

    if (get(this, 'viewportSpy') || !viewportEntered) {
      set(this, 'viewportEntered', hasEnteredViewport);
    }

    this.trigger(triggeredEventName);
  },

  _unbindIfEntered() {
    if (!get(this, 'viewportSpy') && get(this, 'viewportEntered')) {
      this._unbindListeners();
      this.removeObserver('viewportEntered', this, this._unbindIfEntered);
      set(this, 'viewportEntered', true);
    }
  },

  _setInitialViewport() {
    return scheduleOnce('afterRender', this, () => {
      this._setViewportEntered();
    });
  },

  _triggerDidScrollDirectionHandler(event) {
    const sensitivity = get(this, 'viewportScrollSensitivity') || 1;

    this._debouncedEventHandler('_triggerDidScrollDirection', event.currentTarget, sensitivity);
  },

  _setViewportEnteredHandler() {
    this._debouncedEventHandler('_setViewportEntered');
  },

  _debouncedEventHandler(methodName, ...args) {
    assert('You must pass a methodName to _debouncedEventHandler', methodName);
    assert('methodName must be a string', typeOf(methodName) === 'string');

    debounce(this, () => this[methodName](...args), get(this, 'viewportRefreshRate'));
  },

  _bindScrollDirectionListener() {
    const contextEl = get(this, 'scrollableArea') || window;
    let elem = findElem(contextEl);

    elem.addEventListener('scroll', this._triggerDidScrollDirectionHandler);
  },

  _unbindScrollDirectionListener() {
    const elementId = get(this, 'elementId');

    const context = get(this, 'scrollableArea') || window;
    let elem = findElem(context);

    elem.removeEventListener('scroll', this._triggerDidScrollDirectionHandler);
    delete lastPosition[elementId];
    delete lastDirection[elementId];
  },

  _bindListeners(context = null, event = null) {
    assert('You must pass a valid context to _bindListeners', context);
    assert('You must pass a valid event to _bindListeners', event);

    let elem = findElem(context);

    elem.addEventListener(event, this._setViewportEnteredHandler);
  },

  _unbindListeners() {
    const elementId = get(this, 'elementId');

    if (get(this, 'viewportUseRAF')) {
      next(this, () => {
        window.cancelAnimationFrame(rAFIDS[elementId]);
        delete rAFIDS[elementId];
      });
    }

    get(this, 'viewportListeners').forEach((listener) => {
      let { context, event } = listener;
      context = get(this, 'scrollableArea') || context;

      let elem = findElem(context);
      elem.removeEventListener(event, this._setViewportEnteredHandler);
    });

    this._unobserveIntersectionObserver();
    this._unbindScrollDirectionListener();
  },
  
  _unobserveIntersectionObserver() {
    if (this.intersectionObserver) {
      this.intersectionObserver.unobserve(this.element);
    }
  }
});
