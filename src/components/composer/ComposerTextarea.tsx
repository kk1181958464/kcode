import React, {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export type ComposerTextareaHandle = {
  replaceValue(value: string): void;
};

type ComposerTextareaProps = {
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange(value: string): void;
  onBlur(): void;
  onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onSubmit(): void;
};

// Uncontrolled on purpose: a controlled textarea re-renders React on every
// keystroke, which (a) contends with streaming re-renders on the main thread
// and (b) fights the IME during Chinese composition — both surface as typing
// lag. Here the DOM owns the text; the parent is notified via onChange and can
// push values in imperatively via replaceValue (draft load, clear-after-send).
export const ComposerTextarea = memo(
  forwardRef<ComposerTextareaHandle, ComposerTextareaProps>(
    (
      {
        value: initialValue,
        disabled,
        placeholder,
        onChange,
        onBlur,
        onPaste,
        onSubmit,
      },
      ref,
    ) => {
      const innerRef = useRef<HTMLTextAreaElement>(null);

      useImperativeHandle(
        ref,
        () => ({
          replaceValue: (next) => {
            const node = innerRef.current;
            if (node && node.value !== next) node.value = next;
          },
        }),
        [],
      );

      // Sync only when the external value changes (task switch / draft load),
      // never on keystrokes — otherwise this would defeat the uncontrolled design.
      useEffect(() => {
        const node = innerRef.current;
        if (node && node.value !== initialValue) node.value = initialValue;
      }, [initialValue]);

      return (
        <textarea
          ref={innerRef}
          aria-label="任务输入"
          disabled={disabled}
          defaultValue={initialValue}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
        />
      );
    },
  ),
);
