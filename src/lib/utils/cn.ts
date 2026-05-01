import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Tailwind class name merger.
 * shadcn/ui 互換。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
