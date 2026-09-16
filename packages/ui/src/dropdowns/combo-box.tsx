/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Combobox } from "@headlessui/react";
import type { ElementType, KeyboardEventHandler, ReactNode, Ref } from "react";
import React, { forwardRef, useEffect, useRef, useState } from "react";

type Props = {
  as?: ElementType | undefined;
  ref?: Ref<HTMLElement> | undefined;
  tabIndex?: number | undefined;
  className?: string | undefined;
  value?: string | string[] | null;
  onChange?: (value: any) => void;
  disabled?: boolean | undefined;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement> | undefined;
  multiple?: boolean;
  renderByDefault?: boolean;
  button: ReactNode;
  children: ReactNode;
};

const ComboDropDown = forwardRef(function ComboDropDown(props: Props, ref) {
  const { button, renderByDefault = true, children, ...rest } = props;

  const dropDownButtonRef = useRef<HTMLDivElement | null>(null);

  const [shouldRender, setShouldRender] = useState(renderByDefault);

  const onHover = () => {
    setShouldRender(true);
  };

  useEffect(() => {
    const element = dropDownButtonRef.current as any;

    if (!element) return;

    element.addEventListener("mouseenter", onHover);

    return () => {
      element?.removeEventListener("mouseenter", onHover);
    };
  }, [dropDownButtonRef, shouldRender]);

  if (!shouldRender) {
    return (
      <div ref={dropDownButtonRef} className="flex h-full items-center">
        {button}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    <Combobox immediate {...rest} ref={ref}>
      {/* headlessui v2 removed `as={Fragment}` passthrough; forward slot props
          onto the custom button via children-as-function + cloneElement.
          The slot carries headlessui's own `ref` — blind cloneElement would
          REPLACE the consumer's ref (e.g. the popper anchor), dropping the
          popover at (0,0). Merge both refs (and keep the consumer's handlers
          ahead of headlessui's so useDropdown toggling still wins). */}
      <Combobox.Button>
        {(slot: any) => {
          const element = button as React.ReactElement<any>;
          const { ref: slotRef, ...slotRest } = slot ?? {};
          const ownRef = element.ref;
          // Merge refs only: the headlessui slot carries its own `ref`, and a
          // blind cloneElement would REPLACE the consumer's anchor ref (the
          // (0,0) popover bug). Click handling stays exactly as before —
          // headlessui drives it; chaining a second onClick double-toggles.
          const mergedRef = (node: HTMLElement | null) => {
            if (typeof ownRef === "function") ownRef(node);
            else if (ownRef && typeof ownRef === "object") (ownRef as any).current = node;
            if (typeof slotRef === "function") slotRef(node);
            else if (slotRef && typeof slotRef === "object") (slotRef as any).current = node;
          };
          return React.cloneElement(element, { ...slotRest, ref: mergedRef });
        }}
      </Combobox.Button>
      {children}
    </Combobox>
  );
});

const ComboOptions = Combobox.Options;
const ComboOption = Combobox.Option;
const ComboInput = Combobox.Input;

ComboDropDown.displayName = "ComboDropDown";

export { ComboDropDown, ComboOptions, ComboOption, ComboInput };
