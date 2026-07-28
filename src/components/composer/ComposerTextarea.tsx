import React, {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export type ComposerTextareaHandle = {
  getValue(): string;
  replaceValue(value: string): void;
};

type ComposerTextareaProps = {
  value: string;
  disabled: boolean;
  placeholder: string;
  onBlur(value: string): void;
  onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void;
  onSubmit(): void;
};

// Uncontrolled on purpose: a controlled textarea re-renders React on every
// keystroke, which (a) contends with streaming work on the main thread and (b)
// fights the IME during Chinese composition. Here the DOM exclusively owns the
// text while focused; React reads it only at submit/blur/task-switch boundaries.
export const ComposerTextarea = memo(
  forwardRef<ComposerTextareaHandle, ComposerTextareaProps>(
    (
      {
        value: initialValue,
        disabled,
        placeholder,
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
          getValue: () => innerRef.current?.value ?? "",
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
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          defaultValue={initialValue}
          onBlur={(event) => onBlur(event.currentTarget.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
        />
      );
    },
  ),
);
