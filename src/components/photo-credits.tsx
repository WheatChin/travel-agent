import credits from "../../public/image-credits.json";
import { ExternalLink } from "lucide-react";
import { Modal } from "./modal";

export function PhotoCredits({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="图片来源" description="本页摄影图片均保存在本地，授权信息如下。" onClose={onClose} testId="photo-credits-dialog">
      <div className="credit-list">
        {credits.map((credit) => (
          <article className="credit-row" key={credit.path}>
            <div>
              <strong>{credit.title}</strong>
              <p>{credit.creator} · {credit.license}</p>
            </div>
            <a href={credit.sourceUrl} target="_blank" rel="noreferrer">
              原始页面 <ExternalLink aria-hidden="true" size={14} />
            </a>
          </article>
        ))}
      </div>
      <a className="text-link" href="/image-credits.json" target="_blank" rel="noreferrer">查看完整授权清单</a>
    </Modal>
  );
}
