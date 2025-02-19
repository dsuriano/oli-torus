import React, { PropsWithChildren } from 'react';
import { classNames, ClassName } from 'utils/classNames';

import styles from './ThreeStateToggle.modules.scss';

interface ThreeStateToggleProps {
  className?: ClassName;
}

export const ThreeStateToggle = ({
  className,
  children,
}: PropsWithChildren<ThreeStateToggleProps>) => {
  return <div className={classNames(styles.switchToggle, className)}>{children}</div>;
};

interface ToggleOptionProps {
  id: string;
  checked?: boolean;
  onChange?: () => void;
}
export const ToggleOption = ({
  id,
  checked,
  children,
  onChange,
}: PropsWithChildren<ToggleOptionProps>) => {
  return (
    <>
      <input
        type="radio"
        id={id}
        className={styles.input}
        name="state"
        onChange={onChange}
        checked={checked}
      />
      <label htmlFor={id} className={styles.label}>
        {children}
      </label>
    </>
  );
};
