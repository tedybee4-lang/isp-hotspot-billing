import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyTextButtonProps {
  value: string;
  className?: string;
  label?: string;
}

export default function CopyTextButton({ value, className, label = 'Copy' }: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={className}
      aria-label={label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}