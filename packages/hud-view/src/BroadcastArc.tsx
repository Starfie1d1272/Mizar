/** Cropped open arc: a colour plane with an ice front, never a team or state. */
export function BroadcastArc({ hero = false }: { hero?: boolean }) {
  if (hero) {
    return (
      <svg className="broadcast-arc" viewBox="0 0 1920 1080" aria-hidden="true" focusable="false">
        <path
          className="broadcast-arc__depth"
          d="M-100 674C580 1100 1580 1000 2020 680V1180H-100Z"
        />
        <path
          className="broadcast-arc__face"
          d="M-100 730C580 1156 1580 1056 2020 736V1180H-100Z"
        />
        <path
          className="broadcast-arc__front"
          d="M-100 674C580 1100 1580 1000 2020 680L2020 688C1580 1008 580 1108-100 682Z"
        />
        <circle className="broadcast-arc__companion" cx="1804" cy="932" r="10" />
      </svg>
    );
  }
  return (
    <svg className="broadcast-arc" viewBox="0 0 1920 1080" aria-hidden="true" focusable="false">
      <path
        className="broadcast-arc__depth"
        d="M1590-180C1900 170 1970 570 1660 806C1230 1130 380 1000-160 820V1180H2080V-180Z"
      />
      <path
        className="broadcast-arc__face"
        d="M1700-180C1960 180 1980 590 1680 826C1250 1150 360 1020-160 848V1180H2080V-180Z"
      />
      <path
        className="broadcast-arc__front"
        d="M1590-180C1900 170 1970 570 1660 806C1230 1130 380 1000-160 820L-160 830C380 1010 1234 1142 1670 818C1980 580 1910 170 1590-180Z"
      />
      <circle className="broadcast-arc__companion" cx="1814" cy="112" r="8" />
    </svg>
  );
}
