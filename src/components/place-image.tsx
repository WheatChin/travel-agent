"use client";

import { ImageOff } from "lucide-react";
import { useState } from "react";

type PlaceImageProps = {
  src: string;
  alt: string;
  forceFailure?: boolean;
  className?: string;
};

export function PlaceImage({ src, alt, forceFailure = false, className = "" }: PlaceImageProps) {
  const [failed, setFailed] = useState(false);
  if (forceFailure || failed) {
    return (
      <div className={`image-placeholder ${className}`} role="img" aria-label={`${alt}（图片暂不可用）`}>
        <ImageOff aria-hidden="true" size={22} />
        <span>图片暂不可用</span>
      </div>
    );
  }
  return <img className={className} src={src} alt={alt} onError={() => setFailed(true)} />;
}
